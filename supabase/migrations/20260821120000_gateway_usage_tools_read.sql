-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Tool-call telemetry on the canonical usage stream (read half). Surface the
-- gateway_usage_events.tools_used column through the tenant per-request log so
-- the Telemetry page can show the tool names a request invoked, names only.
-- RETURNS TABLE gains a trailing column, so the function is dropped and
-- re-created (a return shape cannot change via CREATE OR REPLACE). Body is
-- unchanged from 20260819233500_gateway_usage_reads.sql apart from the new
-- projection.
--
-- ORDERING: depends on the tools_used column added by the schema half
-- (20260821110000_gateway_usage_tools.sql, gateway usage schema surface), which
-- precedes this in the merge train. This read surface owns list_gateway_usage_events.
--
-- Migration prefix 20260821120000 is collision-free across the assembled train
-- union.

drop function public.list_gateway_usage_events(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
);

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
  created_at pg_catalog.timestamptz,
  tools_used pg_catalog.text[]
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
    events.created_at,
    events.tools_used
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
