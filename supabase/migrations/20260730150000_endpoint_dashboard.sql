-- Model-page dashboard reads and per-endpoint configuration.
--
-- 1. endpoint_usage_timeseries: the per-(model, bucket) rollup behind the
--    overview's savings/token chart and the Usage tab's per-model series.
--    Same honesty rules as endpoint_usage_rollup (tokens and cost sum over
--    ALL rows including errors; unpriced stays a count, never a $0 guess),
--    same epoch-floor bucketing as list_serving_request_buckets. Zero-cost
--    token sums ride along so the savings math can exclude deliberately-free
--    rows (org keys, customer servers) from the frontier baseline, matching
--    serving_request_stats.
-- 2. endpoints gains its first per-endpoint settings: whether telemetry
--    stores request/response bodies, and an optional monthly spend ceiling
--    with an alert threshold. Nullable/defaulted so existing rows keep
--    today's behavior exactly.

create function public.endpoint_usage_timeseries(
  in_org uuid,
  in_endpoint uuid,
  in_after timestamptz default null,
  in_bucket_seconds integer default 86400
)
returns table (
  bucket_start timestamptz,
  model text,
  request_count bigint,
  error_count bigint,
  input_tokens bigint,
  output_tokens bigint,
  cached_tokens bigint,
  cost_usd numeric,
  unpriced_count bigint,
  zero_cost_input_tokens bigint,
  zero_cost_output_tokens bigint,
  zero_cost_cached_tokens bigint
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
    to_timestamp(floor(extract(epoch from requests.created_at) / step) * step)
      as bucket_start,
    coalesce(requests.model, '') as model,
    count(*) filter (where requests.status = 'ok') as request_count,
    count(*) filter (where requests.status = 'error') as error_count,
    coalesce(sum(requests.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(requests.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(requests.cached_tokens), 0)::bigint as cached_tokens,
    coalesce(sum(requests.cost_usd), 0)::numeric as cost_usd,
    count(*) filter (where requests.status = 'ok' and requests.cost_usd is null)
      as unpriced_count,
    coalesce(sum(requests.input_tokens) filter (where requests.cost_usd = 0), 0)::bigint
      as zero_cost_input_tokens,
    coalesce(sum(requests.output_tokens) filter (where requests.cost_usd = 0), 0)::bigint
      as zero_cost_output_tokens,
    coalesce(sum(requests.cached_tokens) filter (where requests.cost_usd = 0), 0)::bigint
      as zero_cost_cached_tokens
    from public.serving_requests requests
   where requests.org_id = in_org
     and requests.endpoint_id = in_endpoint
     and (in_after is null or requests.created_at >= in_after)
   group by 1, 2
   order by 1, 2;
end;
$$;

revoke all on function public.endpoint_usage_timeseries(
  uuid, uuid, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.endpoint_usage_timeseries(
  uuid, uuid, timestamptz, integer
) to service_role;

alter table public.endpoints
  add column store_bodies boolean not null default true,
  add column spend_limit_usd numeric,
  add column spend_alert_fraction numeric;

alter table public.endpoints
  add constraint endpoints_spend_limit_positive
    check (spend_limit_usd is null or spend_limit_usd > 0),
  add constraint endpoints_spend_alert_fraction_range
    check (
      spend_alert_fraction is null
      or (spend_alert_fraction > 0 and spend_alert_fraction <= 1)
    );
