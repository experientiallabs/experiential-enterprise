-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- gateway_observed_model_stats (20260827030000): the catalog's observed-stats
-- aggregate in one round trip — uptime counts, median-interpolating p50s over
-- completed events, the sample floor, the window bound, and the dispatched-only
-- predicate. Regression guard for the 2026-08-22 capacity incident: this RPC
-- replaced a per-request PostgREST offset walk over the whole window.

begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

insert into public.organizations (id, slug, name) values
  ('69000000-0000-0000-0000-000000000001', 'pgtap-gwstats', 'pgTAP GW Stats');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('69000000-0000-0000-0000-000000000011', '69000000-0000-0000-0000-000000000001',
   'gwstats', 'xpl_gws', encode(sha256('gwstats'::bytea), 'hex'));

-- Fixture requests + events. Route (kimi, openrouter): 18 completed at
-- varying latencies/throughputs + 2 failures = 20 terminal events. Route
-- (kimi, anthropic): 5 events (below the floor). One undispatched event
-- (provider null) and one stale event outside the window.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
)
select
  'gws-req-' || n, '69000000-0000-0000-0000-000000000001',
  '69000000-0000-0000-0000-000000000011', 'gws-kimi', 'rev-1', 'chat_completions',
  encode(sha256(('gws-' || n)::bytea), 'hex'),
  now() - interval '2 hours', now() + interval '1 hour', 'completed', now()
from generate_series(1, 27) as n;

-- 18 completed openrouter events: latency 1000..1017 ms (p50 = 1008.5 via
-- interpolation), output 100 tokens each so throughput = 100000/latency and
-- its p50 is 100000/1008.5-ish computed over per-event ratios — assert via
-- the same expression to stay exact.
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, latency_ms,
  status, attempt_count, day, created_at
)
select
  'gws-req-' || n, '69000000-0000-0000-0000-000000000001',
  '69000000-0000-0000-0000-000000000011', 'gws-kimi', 'openrouter',
  'pass_through', 10, 100, 0, 1000, 999 + n,
  'completed', 1, current_date, now() - interval '1 hour'
from generate_series(1, 18) as n;
-- 2 failures on the same route (no latency, no tokens).
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, latency_ms,
  status, attempt_count, day, created_at
)
select
  'gws-req-' || n, '69000000-0000-0000-0000-000000000001',
  '69000000-0000-0000-0000-000000000011', 'gws-kimi', 'openrouter',
  'pass_through', 10, 0, 0, 0, null,
  'failed', 1, current_date, now() - interval '1 hour'
from generate_series(19, 20) as n;
-- 5 anthropic events: below the sample floor, must not surface.
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, latency_ms,
  status, attempt_count, day, created_at
)
select
  'gws-req-' || n, '69000000-0000-0000-0000-000000000001',
  '69000000-0000-0000-0000-000000000011', 'gws-kimi', 'anthropic',
  'pass_through', 10, 50, 0, 500, 800,
  'completed', 1, current_date, now() - interval '1 hour'
from generate_series(21, 25) as n;
-- Undispatched: provider null, never attributable to a route.
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, latency_ms,
  status, attempt_count, day, created_at
) values (
  'gws-req-26', '69000000-0000-0000-0000-000000000001',
  '69000000-0000-0000-0000-000000000011', 'gws-kimi', null, null, 0, 0, 0, 0,
  null, 'expired_before_dispatch', 0, current_date, now() - interval '1 hour');
-- Stale: outside the requested window.
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, latency_ms,
  status, attempt_count, day, created_at
) values (
  'gws-req-27', '69000000-0000-0000-0000-000000000001',
  '69000000-0000-0000-0000-000000000011', 'gws-kimi', 'openrouter',
  'pass_through', 10, 0, 0, 0, null,
  'failed', 1, current_date, now() - interval '40 days');

select is(
  (select count(*) from public.gateway_observed_model_stats(now() - interval '30 days')
     as cells where cells.alias = 'gws-kimi'),
  1::bigint,
  'only routes past the sample floor surface (dispatched, in-window)');

select results_eq(
  $$select cells.alias, cells.provider, cells.sample_count, cells.completed_count
      from public.gateway_observed_model_stats(now() - interval '30 days') as cells
     where cells.alias = 'gws-kimi'$$,
  $$values ('gws-kimi'::text, 'openrouter'::text, 20::bigint, 18::bigint)$$,
  'the surfaced route counts terminal and completed events (stale + undispatched excluded)');

select is(
  (select cells.latency_p50_ms from public.gateway_observed_model_stats(
     now() - interval '30 days') as cells where cells.alias = 'gws-kimi'),
  1008.5::float8,
  'latency p50 interpolates between the two middle values, exactly like statistics.median');

select is(
  (select cells.throughput_p50_tps from public.gateway_observed_model_stats(
     now() - interval '30 days') as cells where cells.alias = 'gws-kimi'),
  -- Same division order as the RPC's expression, so the float64 result is
  -- bit-identical rather than merely mathematically equal.
  (select percentile_cont(0.5) within group (
     order by 100.0::float8 / ((999 + n)::float8 / 1000.0))
     from generate_series(1, 18) as n)::float8,
  'throughput p50 aggregates per-event tokens/second ratios');

select is(
  (select count(*) from public.gateway_observed_model_stats(
     now() - interval '30 days', 5) as cells where cells.alias = 'gws-kimi'),
  2::bigint,
  'a lower sample floor surfaces the quieter route too');

select is(
  (select cells.throughput_p50_tps from public.gateway_observed_model_stats(
     now() - interval '30 days', 5) as cells
     where cells.alias = 'gws-kimi' and cells.provider = 'anthropic'),
  62.5::float8,
  'a uniform route reports its exact per-event throughput (50 tokens / 0.8 s)');

select is(
  (select count(*) from public.gateway_observed_model_stats(now() + interval '1 hour')
     as cells where cells.alias = 'gws-kimi'),
  0::bigint,
  'a future window lower bound returns nothing');

-- Failures with no positive latency contribute to uptime but never to p50s:
-- drop all completed events'' latencies by re-checking the below-floor route
-- at floor 5 (all completed) — its latency p50 is present, so instead assert
-- the surfaced main route ignores its two latency-less failures in the p50
-- (1008.5 comes from exactly the 18 completed events).
select is(
  (select cells.sample_count - cells.completed_count
     from public.gateway_observed_model_stats(now() - interval '30 days') as cells
     where cells.alias = 'gws-kimi'),
  2::bigint,
  'failures count toward the sample (uptime denominator) without polluting the p50s');

select finish();

rollback;
