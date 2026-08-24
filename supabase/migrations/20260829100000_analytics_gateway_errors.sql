-- Error-report reads for the nightly digest's Errors section (gw/analytics).
--
-- Request-level failures come from gateway_usage_events, the canonical
-- stream analytics already reads. Two reads that stream cannot answer live
-- here instead: the attempt-level failure_class breakdown (a request that
-- recovered on a fallback attempt settles a clean usage event, so provider
-- flakiness is only visible per attempt) and the worker registry's health
-- snapshot. Both tables are gateway-internal per the usage-store contract
-- ("Billing, telemetry, and analytics read these two tables and nothing
-- else of the gateway's"), so the reads are exposed as explicit
-- service-role-only definer functions — the same shape as
-- analytics_org_member_emails — rather than direct selects from web code.

create or replace function public.analytics_gateway_attempt_failures(
  in_from pg_catalog.timestamptz,
  in_to pg_catalog.timestamptz
)
returns table (failure_class pg_catalog.text, attempts pg_catalog.int8)
language sql
stable
security definer
set search_path = ''
as $$
  -- Windowed on terminal_at, the failure's settlement clock: an attempt
  -- dispatched before the boundary that fails inside the window belongs to
  -- this report, not to none. Every failure-family row has one (the DDL
  -- enforces state = 'dispatched' <=> terminal_at is null), and it matches
  -- how the request lane windows usage events, which are stamped at
  -- settlement.
  select
    failed.failure_class,
    pg_catalog.count(*) as attempts
  from public.gateway_attempts failed
  where failed.terminal_at >= in_from
    and failed.terminal_at < in_to
    and failed.state in ('failed', 'unknown_after_crash')
  group by failed.failure_class;
$$;

revoke all on function public.analytics_gateway_attempt_failures(
  pg_catalog.timestamptz, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.analytics_gateway_attempt_failures(
  pg_catalog.timestamptz, pg_catalog.timestamptz
) to service_role;

-- The whole registry: one row per worker id (heartbeats upsert in place, so
-- there is no transition history to window over server-side). Incident
-- classification — dead in the window, stale heartbeat, boots in the window
-- — happens in the digest's pure aggregation where it is unit-tested.
create or replace function public.analytics_gateway_worker_snapshot()
returns table (
  worker_id pg_catalog.text,
  state pg_catalog.text,
  started_at pg_catalog.timestamptz,
  heartbeat_at pg_catalog.timestamptz,
  created_at pg_catalog.timestamptz,
  app_version pg_catalog.text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    workers.worker_id,
    workers.state,
    workers.started_at,
    workers.heartbeat_at,
    workers.created_at,
    workers.app_version
  from public.gateway_workers workers;
$$;

revoke all on function public.analytics_gateway_worker_snapshot()
  from public, anon, authenticated;
grant execute on function public.analytics_gateway_worker_snapshot()
  to service_role;
