-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Surface cached input tokens on the tenant usage timeseries.
--
-- 20260821200000_gateway_usage_metadata_errors.sql carried cached_input_tokens
-- onto gateway_usage_events and the per-request log, but the bucket aggregate
-- (gateway_usage_timeseries) still dropped it, so no window-wide consumer could
-- see cache behavior. The named consumer is the Insights suggestions engine
-- (explabs/api/suggestions.py): its caching and compression rules need the
-- org's window-wide input/cached token split to derive honest dollar estimates,
-- and the capped recent-events sample the latency rule uses is too small a base
-- for money math.
--
-- The return-shape changes, so the function is dropped and re-created from its
-- 20260819233500_gateway_usage_reads.sql definition with one trailing
-- cached_input_tokens sum; body otherwise unchanged. Grants are re-issued
-- verbatim (service_role only, like every tenant read RPC). Migration prefix
-- 20260822093000 is collision-free across the assembled train union.

drop function public.gateway_usage_timeseries(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.int4,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text
);

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
  estimated_cost_micro_usd pg_catalog.int8,
  cached_input_tokens pg_catalog.int8
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
      as estimated_cost_micro_usd,
    -- Cache reads inside input_tokens (subset, never additive); 0 for rows
    -- settled before the column existed.
    coalesce(pg_catalog.sum(events.cached_input_tokens), 0)::pg_catalog.int8
      as cached_input_tokens
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
