-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Subset pricing of cached/reasoning tokens and the cached column on the
-- tenant timeseries (20260822090000_gateway_cost_subset_pricing.sql,
-- 20260822093000_gateway_usage_timeseries_cached.sql).
--
-- WMO's usage contract makes cached input a subset of input_tokens and
-- reasoning a subset of output_tokens; the cost function must price the
-- subset at its discounted rate and only the remainder at the base rate,
-- never both, and must not refuse to price a route whose base rates are
-- known just because a secondary rate is undeclared.

begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- 1. The cost function prices subsets, not sums. Rates are micro-USD per
--    million tokens; results are micro-USD, rounded half-up.

-- $10/M input, $1/M cached, $50/M output; 1000 input of which 400 cached:
-- 600 * $10/M + 400 * $1/M + 100 * $50/M = $0.0114.
select is(
  public.gateway_attempt_cost_micro_usd(
    1000, 400, 100, null, 10000000, 1000000, 50000000, null),
  11400::bigint,
  'cached input tokens price at the cached rate and only the fresh remainder at the input rate');

-- No cached rate declared: the cached subset falls back to the input rate,
-- which is exactly pricing the total input once.
select is(
  public.gateway_attempt_cost_micro_usd(
    1000, 400, 100, null, 10000000, null, 50000000, null),
  15000::bigint,
  'an undeclared cached rate prices cached tokens at the input rate instead of refusing');

-- Reasoning tokens are a subset of output; with no reasoning rate they price
-- at the output rate (the pre-fix formula returned NULL here, settling
-- host-funded traffic at $0).
select is(
  public.gateway_attempt_cost_micro_usd(
    100, null, 1000, 300, 10000000, null, 50000000, null),
  51000::bigint,
  'reasoning tokens without a reasoning rate price at the output rate');

-- A declared reasoning rate prices the subset, remainder at the output rate:
-- 100 * $10/M + 700 * $50/M + 300 * $20/M = $0.042.
select is(
  public.gateway_attempt_cost_micro_usd(
    100, null, 1000, 300, 10000000, null, 50000000, 20000000),
  42000::bigint,
  'a declared reasoning rate prices only the reasoning subset');

-- A malformed provider report (subset exceeding its total) clamps to the
-- total instead of inflating the bill.
select is(
  public.gateway_attempt_cost_micro_usd(
    100, 500, 0, null, 10000000, 1000000, 50000000, null),
  100::bigint,
  'a cached count above the input total clamps to the total');

-- Unknown BASE rates still refuse to price.
select is(
  public.gateway_attempt_cost_micro_usd(
    100, null, 10, null, null, null, 50000000, null),
  null,
  'fresh input tokens with an unknown input rate stay unpriceable');
select is(
  public.gateway_attempt_cost_micro_usd(
    null, null, null, null, 10000000, null, 50000000, null),
  null,
  'absent usage (no token counts at all) stays unpriceable');

-- ---------------------------------------------------------------------------
-- 2. The settle wire: a pass-through attempt with frozen rates and cache hits
--    settles the subset-priced estimate onto the attempt and the event.

insert into public.organizations (id, slug, name) values
  ('67000000-0000-0000-0000-000000000001', 'pgtap-gwcache', 'pgTAP GW Cache');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('67000000-0000-0000-0000-000000000011', '67000000-0000-0000-0000-000000000001',
   'gwcache', 'xpl_gwc', encode(sha256('gwcache'::bytea), 'hex'));
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwc-req-1', '67000000-0000-0000-0000-000000000001',
  '67000000-0000-0000-0000-000000000011', 'fable', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '2 seconds', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, cached_input_rate_micro_usd,
  output_rate_micro_usd, budget_period_start
) values (
  'gwc-att-1', 'gwc-req-1', '67000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'anthropic', 'claude-fable', 'pool-1', repeat('ab', 32),
  'customer_managed', 'dispatched', now(), 10000000, 1000000, 50000000, now());

select public.gateway_settle_attempt(
  'gwc-att-1', 'completed', null, 1000, 400, 100, null, 'observed', true);

select is(
  (select estimated_cost_micro_usd from public.gateway_attempts
    where attempt_id = 'gwc-att-1'),
  11400::bigint,
  'settle prices the attempt with the subset formula');
select is(
  (select estimated_cost_micro_usd from public.gateway_usage_events
    where request_id = 'gwc-req-1'),
  11400::bigint,
  'the usage event carries the subset-priced pass-through estimate');
select is(
  (select pricing_known from public.gateway_usage_events
    where request_id = 'gwc-req-1'),
  true,
  'a route with frozen base rates reads pricing_known');

-- ---------------------------------------------------------------------------
-- 3. The timeseries aggregate sums cached input tokens per cell.

select is(
  (select sum(cells.cached_input_tokens) from public.gateway_usage_timeseries(
    '67000000-0000-0000-0000-000000000001', null, 3600
  ) as cells),
  400::numeric,
  'gateway_usage_timeseries sums cached_input_tokens');
select results_eq(
  $$select cells.input_tokens, cells.cached_input_tokens
      from public.gateway_usage_timeseries(
        '67000000-0000-0000-0000-000000000001', null, 3600) as cells$$,
  $$values (1000::bigint, 400::bigint)$$,
  'the cached sum rides the same cell as its input total');

select finish();

rollback;
