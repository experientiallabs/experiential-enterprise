-- Gateway usage reads: the tenant telemetry read path over the canonical
-- usage store (`gateway_usage_events`, written in the settlement transaction;
-- see 20260819190000_gateway_runtime.sql for the column contract).
--
-- Three read-only RPCs back the Telemetry page's tenant endpoints:
--
--   gateway_usage_timeseries    per-(bucket, alias, lane) aggregates for the
--                               spend/usage charts (org-wide, filterable)
--   gateway_usage_by_key        per-(api key, alias) rollup for the Agents
--                               section, labels joined from api_keys
--   list_gateway_usage_events   the keyset-paginated per-request log
--
-- Semantics shared by all three:
--   * request_count counts every FINISHED request, errors included;
--     error_count is the subset whose terminal state is not 'completed'.
--     Tokens and cost sum over all counted rows.
--   * Money stays the ledger's integer micro-USD and keeps its two-column
--     split: cost_micro_usd is CHARGED platform credits only (insurance
--     applied; zero for pure-BYOK requests) and estimated_cost_micro_usd is
--     the attributed, never-charged pass-through estimate. Callers convert
--     for display and may add the two for an all-spend headline, but the
--     split must survive to the boundary so estimates never read as billed
--     money. Nothing here rounds.
--   * lane is null when nothing was dispatched (no lane was exercised); a
--     lane filter therefore never matches those rows.
--   * The store is content-free by design: there are no request/response
--     bodies to read, so the log RPC returns the full tenant-visible event.

create function public.gateway_usage_timeseries(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null,
  in_bucket_seconds pg_catalog.int4 default 86400,
  in_alias pg_catalog.text default null,
  in_api_key_id pg_catalog.uuid default null,
  in_lane pg_catalog.text default null
)
returns table (
  bucket_start pg_catalog.timestamptz,
  alias pg_catalog.text,
  lane pg_catalog.text,
  request_count pg_catalog.int8,
  error_count pg_catalog.int8,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Same epoch-floor bucketing as endpoint_usage_timeseries, so gateway and
  -- legacy charts bucket identically during the transition.
  step pg_catalog.int4 := greatest(coalesce(in_bucket_seconds, 86400), 60);
begin
  if in_lane is not null
     and in_lane not in ('pass_through', 'platform_funded') then
    raise exception using errcode = '22023',
      message = 'invalid gateway usage lane filter';
  end if;
  return query
  select
    pg_catalog.to_timestamp(
      pg_catalog.floor(extract(epoch from events.created_at) / step) * step
    ) as bucket_start,
    events.alias,
    events.lane,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    (pg_catalog.count(*) filter (where events.status <> 'completed')
      )::pg_catalog.int8 as error_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as input_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as output_tokens,
    coalesce(pg_catalog.sum(events.cost_micro_usd), 0)::pg_catalog.int8
      as cost_micro_usd,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd
  from public.gateway_usage_events events
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
    and (in_alias is null or events.alias = in_alias)
    and (in_api_key_id is null or events.api_key_id = in_api_key_id)
    and (in_lane is null or events.lane = in_lane)
  group by 1, 2, 3
  order by 1, 2, 3;
end;
$$;

revoke all on function public.gateway_usage_timeseries(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.int4,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_usage_timeseries(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.int4,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text
) to service_role;

create function public.gateway_usage_by_key(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null
)
returns table (
  api_key_id pg_catalog.uuid,
  key_label pg_catalog.text,
  alias pg_catalog.text,
  request_count pg_catalog.int8,
  error_count pg_catalog.int8,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
  last_used_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- events.api_key_id is an attribution snapshot without a foreign key, so a
  -- deleted key keeps its history and reads back with a null label.
  return query
  select
    events.api_key_id,
    keys.name as key_label,
    events.alias,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    (pg_catalog.count(*) filter (where events.status <> 'completed')
      )::pg_catalog.int8 as error_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as input_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as output_tokens,
    coalesce(pg_catalog.sum(events.cost_micro_usd), 0)::pg_catalog.int8
      as cost_micro_usd,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd,
    pg_catalog.max(events.created_at) as last_used_at
  from public.gateway_usage_events events
  left join public.api_keys keys on keys.id = events.api_key_id
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
  group by events.api_key_id, keys.name, events.alias
  -- Bounded to the PostgREST max_rows cap (supabase/config.toml: 1000) by
  -- descending traffic: if a tenant's (key, model) cardinality ever reaches the
  -- cap, the highest-volume cells are retained deterministically instead of
  -- PostgREST silently truncating an arbitrary page and the API treating the
  -- partial rollup as complete. Display rollup only; settlement reads
  -- gateway_usage_events directly.
  order by pg_catalog.count(*) desc, events.api_key_id, events.alias
  limit 1000;
end;
$$;

revoke all on function public.gateway_usage_by_key(
  pg_catalog.uuid, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.gateway_usage_by_key(
  pg_catalog.uuid, pg_catalog.timestamptz
) to service_role;

create function public.list_gateway_usage_events(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_alias pg_catalog.text default null,
  in_api_key_id pg_catalog.uuid default null,
  in_lane pg_catalog.text default null,
  in_status pg_catalog.text default null,
  in_cursor_ts pg_catalog.timestamptz default null,
  in_cursor_id pg_catalog.text default null,
  in_limit pg_catalog.int4 default 50
)
returns table (
  request_id pg_catalog.text,
  api_key_id pg_catalog.uuid,
  key_label pg_catalog.text,
  alias pg_catalog.text,
  provider pg_catalog.text,
  lane pg_catalog.text,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
  latency_ms pg_catalog.int4,
  status pg_catalog.text,
  attempt_count pg_catalog.int4,
  created_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  if in_lane is not null
     and in_lane not in ('pass_through', 'platform_funded') then
    raise exception using errcode = '22023',
      message = 'invalid gateway usage lane filter';
  end if;
  -- 'error' is the one aggregate shorthand: every terminal state that is not
  -- 'completed', matching the timeseries' error_count.
  if in_status is not null and in_status not in (
    'completed', 'failed', 'cancelled', 'incomplete',
    'expired_before_dispatch', 'unknown_after_crash', 'error'
  ) then
    raise exception using errcode = '22023',
      message = 'invalid gateway usage status filter';
  end if;
  return query
  select
    events.request_id,
    events.api_key_id,
    keys.name as key_label,
    events.alias,
    events.provider,
    events.lane,
    events.input_tokens,
    events.output_tokens,
    events.cost_micro_usd,
    events.estimated_cost_micro_usd,
    events.latency_ms,
    events.status,
    events.attempt_count,
    events.created_at
  from public.gateway_usage_events events
  left join public.api_keys keys on keys.id = events.api_key_id
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
    and (in_before is null or events.created_at < in_before)
    and (in_alias is null or events.alias = in_alias)
    and (in_api_key_id is null or events.api_key_id = in_api_key_id)
    and (in_lane is null or events.lane = in_lane)
    and (
      in_status is null
      or (in_status = 'error' and events.status <> 'completed')
      or events.status = in_status
    )
    and (
      in_cursor_ts is null or in_cursor_id is null
      or (events.created_at, events.request_id) < (in_cursor_ts, in_cursor_id)
    )
  order by events.created_at desc, events.request_id desc
  limit cap;
end;
$$;

revoke all on function public.list_gateway_usage_events(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.list_gateway_usage_events(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
) to service_role;
