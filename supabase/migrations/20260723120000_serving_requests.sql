-- Serving request log (D-SERVING-LOG v1).
--
-- One row per call served through a hosted endpoint: the operational record
-- behind the Telemetry page. The read path (this migration's RPCs, the
-- explabs serving_requests routes, the Telemetry UI) ships first; the
-- endpoint serving path inserts rows as it serves traffic, and seeded rows
-- stand in until it lands.
--
-- The row deliberately carries MORE than the UI shows: `model`, `cluster_id`
-- and `cluster_label` record the learned inference policy's per-call decision
-- so the contract is ready when that surface opens, but the product keeps
-- routing opaque ("you hit a model"), so no read RPC exposes a per-row model
-- or cluster column to the UI today. Request/response bodies are stored in
-- full and returned only by the single-row fetch, never in lists.
--
-- Reads go through service-role RPCs (the API enforces org membership before
-- calling, like telemetry): aggregation and keyset pagination cannot be
-- expressed through PostgREST query building, and list results must stay
-- under the max-rows cap.

create table public.serving_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The endpoint this call was served by. No FK yet: the endpoints table
  -- lands with the optimization workstream; the label is denormalized so the
  -- log renders standalone.
  endpoint_id uuid not null,
  endpoint_label text not null,
  -- Learned-inference-policy fields: stored for the contract, not rendered.
  model text,
  cluster_id text,
  cluster_label text,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cached_tokens bigint not null default 0 check (cached_tokens >= 0),
  -- Cache-adjusted real cost of the call; null when the served model has no
  -- verified price (never a $0 guess).
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  -- Time to first streamed byte; the endpoint serves streaming responses.
  ttfb_ms integer check (ttfb_ms is null or ttfb_ms >= 0),
  status text not null default 'ok' check (status in ('ok', 'error')),
  error_message text,
  -- Full request/response bodies (OpenAI-compatible chat payloads). The
  -- write path truncates oversized bodies to a marker object BEFORE insert
  -- (a log row must never be lost to body size); these checks are the
  -- backstop, sized above the write-path cap. An org-level retention
  -- control is an aux-settings surface.
  request jsonb check (request is null or pg_column_size(request) <= 2097152),
  response jsonb check (response is null or pg_column_size(response) <= 2097152),
  created_at timestamptz not null default now()
);

create index serving_requests_org_created_idx
  on public.serving_requests (org_id, created_at desc, id desc);

create index serving_requests_org_endpoint_created_idx
  on public.serving_requests (org_id, endpoint_id, created_at desc, id desc);

create index serving_requests_org_error_idx
  on public.serving_requests (org_id, created_at desc)
  where status = 'error';

alter table public.serving_requests enable row level security;

-- No PostgREST surface: every read goes through the shaped service-role RPCs
-- below (the API gates membership), and a direct table SELECT would expose
-- the routing fields and full bodies this migration deliberately keeps out
-- of every read path. No policies + an explicit revoke keeps the table
-- invisible to the anon/authenticated REST roles.
revoke all on table public.serving_requests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read RPCs. Service-role only; the API gates org membership before calling.
-- ---------------------------------------------------------------------------

-- Newest-first keyset-paginated list. Bodies are excluded on purpose: list
-- rows must stay light, the detail RPC-less single-row fetch returns them.
create or replace function public.list_serving_requests(
  in_org uuid,
  in_endpoint uuid default null,
  in_status text default null,
  in_after timestamptz default null,
  in_before timestamptz default null,
  in_cursor_ts timestamptz default null,
  in_cursor_id uuid default null,
  in_limit integer default 50
)
returns table (
  id uuid,
  endpoint_id uuid,
  endpoint_label text,
  input_tokens bigint,
  output_tokens bigint,
  cached_tokens bigint,
  cost_usd numeric,
  latency_ms integer,
  ttfb_ms integer,
  status text,
  error_message text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap integer := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  return query
  select
    requests.id,
    requests.endpoint_id,
    requests.endpoint_label,
    requests.input_tokens,
    requests.output_tokens,
    requests.cached_tokens,
    requests.cost_usd,
    requests.latency_ms,
    requests.ttfb_ms,
    requests.status,
    requests.error_message,
    requests.created_at
    from public.serving_requests requests
   where requests.org_id = in_org
     and (in_endpoint is null or requests.endpoint_id = in_endpoint)
     and (in_status is null or requests.status = in_status)
     and (in_after is null or requests.created_at >= in_after)
     and (in_before is null or requests.created_at < in_before)
     and (
       in_cursor_ts is null
       or in_cursor_id is null
       or (requests.created_at, requests.id) < (in_cursor_ts, in_cursor_id)
     )
   order by requests.created_at desc, requests.id desc
   limit cap;
end;
$$;

revoke all on function public.list_serving_requests(
  uuid, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_serving_requests(
  uuid, uuid, text, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;

-- Window aggregates behind the hero strip: traffic, errors, spend, tokens,
-- latency percentiles.
create or replace function public.serving_request_stats(
  in_org uuid,
  in_endpoint uuid default null,
  in_after timestamptz default null,
  in_before timestamptz default null
)
returns table (
  request_count bigint,
  error_count bigint,
  -- Rows with no verified price: surfaced so a spend total over a partially
  -- priced window never silently under-reports (house cost honesty rule).
  unpriced_count bigint,
  cost_usd_total numeric,
  input_tokens_total bigint,
  output_tokens_total bigint,
  cached_tokens_total bigint,
  latency_p50_ms double precision,
  latency_p95_ms double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    count(*),
    count(*) filter (where requests.status = 'error'),
    count(*) filter (where requests.cost_usd is null),
    sum(requests.cost_usd),
    coalesce(sum(requests.input_tokens), 0)::bigint,
    coalesce(sum(requests.output_tokens), 0)::bigint,
    coalesce(sum(requests.cached_tokens), 0)::bigint,
    percentile_cont(0.5) within group (order by requests.latency_ms),
    percentile_cont(0.95) within group (order by requests.latency_ms)
    from public.serving_requests requests
   where requests.org_id = in_org
     and (in_endpoint is null or requests.endpoint_id = in_endpoint)
     and (in_after is null or requests.created_at >= in_after)
     and (in_before is null or requests.created_at < in_before);
end;
$$;

revoke all on function public.serving_request_stats(
  uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.serving_request_stats(
  uuid, uuid, timestamptz, timestamptz
) to service_role;

-- Time-bucketed traffic for the activity chart. Buckets with no rows are
-- absent; the frontend fills gaps.
create or replace function public.list_serving_request_buckets(
  in_org uuid,
  in_endpoint uuid default null,
  in_after timestamptz default null,
  in_before timestamptz default null,
  in_bucket_seconds integer default 86400
)
returns table (
  bucket_start timestamptz,
  request_count bigint,
  error_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  step integer := greatest(coalesce(in_bucket_seconds, 86400), 60);
begin
  return query
  select
    to_timestamp(floor(extract(epoch from requests.created_at) / step) * step),
    count(*),
    count(*) filter (where requests.status = 'error')
    from public.serving_requests requests
   where requests.org_id = in_org
     and (in_endpoint is null or requests.endpoint_id = in_endpoint)
     and (in_after is null or requests.created_at >= in_after)
     and (in_before is null or requests.created_at < in_before)
   group by 1
   order by 1;
end;
$$;

revoke all on function public.list_serving_request_buckets(
  uuid, uuid, timestamptz, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.list_serving_request_buckets(
  uuid, uuid, timestamptz, timestamptz, integer
) to service_role;

-- Distinct endpoints that have served traffic: the filter dropdown, and the
-- "does this org serve anything yet" gate for showing the Telemetry surface.
-- Capped at the 100 most recently active endpoints: both consumers only need
-- a bounded, recency-ordered set, and the cap keeps the GROUP BY's output
-- (not its scan) fixed as history grows.
create or replace function public.list_serving_endpoints(
  in_org uuid
)
returns table (
  endpoint_id uuid,
  endpoint_label text,
  request_count bigint,
  last_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    requests.endpoint_id,
    -- The label of the most recent row: labels are denormalized per row, so
    -- a relabeled endpoint must show its current name, not the max() one.
    (array_agg(requests.endpoint_label order by requests.created_at desc))[1],
    count(*),
    max(requests.created_at)
    from public.serving_requests requests
   where requests.org_id = in_org
   group by requests.endpoint_id
   order by max(requests.created_at) desc
   limit 100;
end;
$$;

revoke all on function public.list_serving_endpoints(uuid)
  from public, anon, authenticated;
grant execute on function public.list_serving_endpoints(uuid)
  to service_role;
