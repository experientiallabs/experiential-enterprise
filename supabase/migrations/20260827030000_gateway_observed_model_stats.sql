-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- One-round-trip aggregate behind the catalog's observed model stats.
--
-- Recurrence prevention for the 2026-08-22 capacity incident: the catalog's
-- observed-stats overlay (explabs/api/routes/model_stats.py) used to walk the
-- ENTIRE trailing-30-day, cross-org gateway_usage_events window through
-- PostgREST in offset pages and accumulate every row in api-process memory
-- before aggregating — invoked from the PUBLIC catalog endpoints, so anonymous
-- storefront traffic drove an O(window-rows) PostgREST walk per request and an
-- unbounded per-request memory footprint. Deleting the incident's 245k-row
-- usage seed removed that day's trigger, but the walk re-created the same
-- march as real usage accumulated. The #644 hotfix bounded api concurrency and
-- the web catalog fetch; this migration removes the cause: the aggregation
-- happens in the database, one query per catalog read, returning one row per
-- (alias, provider) route.
--
-- Semantics are byte-for-byte the Python aggregate it replaces:
--   * only dispatched events count (provider is not null) — an event with no
--     winning attempt cannot be attributed to a provider route;
--   * sample_count counts every terminal event in the window, completed_count
--     the completed subset (uptime = completed/sample, computed by the caller);
--   * p50s use percentile_cont(0.5), which interpolates exactly like Python's
--     statistics.median, over COMPLETED events with a positive latency
--     (throughput additionally requires positive output tokens);
--   * routes below in_min_sample terminal events are never returned, so a
--     single request can never become a headline number.
--
-- Cross-org by design (the public catalog's stats are population aggregates;
-- only these aggregates are exposed, never per-org rows), so service-role
-- only, exactly like the other gateway read RPCs. Migration prefix
-- 20260827030000 is collision-free across the assembled train union.

create function public.gateway_observed_model_stats(
  in_after pg_catalog.timestamptz,
  in_min_sample pg_catalog.int4 default 20
)
returns table (
  alias pg_catalog.text,
  provider pg_catalog.text,
  sample_count pg_catalog.int8,
  completed_count pg_catalog.int8,
  latency_p50_ms pg_catalog.float8,
  throughput_p50_tps pg_catalog.float8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    events.alias,
    events.provider,
    pg_catalog.count(*)::pg_catalog.int8 as sample_count,
    (pg_catalog.count(*) filter (where events.status = 'completed')
      )::pg_catalog.int8 as completed_count,
    (percentile_cont(0.5) within group (order by events.latency_ms::pg_catalog.float8)
       filter (where events.status = 'completed' and events.latency_ms > 0)
      )::pg_catalog.float8 as latency_p50_ms,
    (percentile_cont(0.5) within group (
         order by events.output_tokens::pg_catalog.float8
           / (events.latency_ms::pg_catalog.float8 / 1000.0))
       filter (where events.status = 'completed'
         and events.latency_ms > 0 and events.output_tokens > 0)
      )::pg_catalog.float8 as throughput_p50_tps
  from public.gateway_usage_events events
  where events.provider is not null
    and events.created_at >= in_after
  group by events.alias, events.provider
  having pg_catalog.count(*) >= in_min_sample
  order by events.alias, events.provider;
end;
$$;

revoke all on function public.gateway_observed_model_stats(
  pg_catalog.timestamptz, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_observed_model_stats(
  pg_catalog.timestamptz, pg_catalog.int4
) to service_role;
