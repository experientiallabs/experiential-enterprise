-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Fine-grained per-call telemetry on the canonical usage stream
-- (20260821200000_gateway_usage_metadata_errors.sql): the token breakdown
-- (cached/reasoning), the pricing_known signal that keeps an unpriced call from
-- reading as free, and the outcome reason (failure_class + sanitized
-- error_message) all flow from the settled attempt (or the pre-dispatch request)
-- through gateway_finalize_usage onto the usage event, content-free throughout.

begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Storage shape.
select has_column('public', 'gateway_usage_events', 'cached_input_tokens',
  'gateway_usage_events carries cached_input_tokens');
select has_column('public', 'gateway_usage_events', 'reasoning_tokens',
  'gateway_usage_events carries reasoning_tokens');
select has_column('public', 'gateway_usage_events', 'pricing_known',
  'gateway_usage_events carries pricing_known');
select has_column('public', 'gateway_usage_events', 'failure_class',
  'gateway_usage_events carries failure_class');
select has_column('public', 'gateway_usage_events', 'error_message',
  'gateway_usage_events carries error_message');
select has_column('public', 'gateway_attempts', 'error_message',
  'gateway_attempts carries the error_message finalize copies onto the event');
select has_column('public', 'gateway_requests', 'terminal_failure_class',
  'gateway_requests carries the pre-dispatch terminal_failure_class');
select has_column('public', 'gateway_requests', 'terminal_error_message',
  'gateway_requests carries the pre-dispatch terminal_error_message');

-- Fixtures: one org and key; each case gets its own request + winning attempt.
insert into public.organizations (id, slug, name) values
  ('66000000-0000-0000-0000-000000000001', 'pgtap-gwmeta', 'pgTAP GW Meta');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('66000000-0000-0000-0000-000000000011', '66000000-0000-0000-0000-000000000001',
   'gwmeta', 'xpl_gwm', encode(sha256('gwmeta'::bytea), 'hex'));

-- Case A: a priced, terminal request whose winning attempt recorded cached and
-- reasoning tokens; finalize copies the breakdown and marks it priced.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
) values (
  'gwm-req-1', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '3 seconds', now() + interval '60 seconds',
  'completed', now());
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, input_rate_micro_usd, output_rate_micro_usd,
  input_tokens, cached_input_tokens, output_tokens,
  reasoning_tokens, usage_source, estimated_cost_micro_usd, budget_period_start
) values (
  'gwm-att-1', 'gwm-req-1', '66000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'host_managed',
  'completed', now(), now(), 1000000, 2000000, 42, 8, 7, 3, 'observed', 2026, now());

select public.gateway_finalize_usage('gwm-req-1');

select is(
  (select cached_input_tokens from public.gateway_usage_events where request_id = 'gwm-req-1'),
  8::bigint,
  'finalize copies cached_input_tokens onto the usage event');
select is(
  (select reasoning_tokens from public.gateway_usage_events where request_id = 'gwm-req-1'),
  3::bigint,
  'finalize copies reasoning_tokens onto the usage event');
select is(
  (select pricing_known from public.gateway_usage_events where request_id = 'gwm-req-1'),
  true,
  'a priced route (frozen base rates present) marks the event pricing_known');
select is(
  (select failure_class from public.gateway_usage_events where request_id = 'gwm-req-1'),
  null,
  'a completed request carries no failure class');

-- Case B: the full settle wire for a genuinely UNPRICED route (null frozen
-- rates -- a BYOK binding with no price). The route has no known price, so the
-- event reads pricing_known = false and its $0 cost surfaces as "unpriced".
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwm-req-2', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, budget_period_start
) values (
  'gwm-att-2', 'gwm-req-2', '66000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'host_managed',
  'dispatched', now(), now());

select public.gateway_settle_attempt(
  'gwm-att-2', 'completed', null, 38, null, 1013, null, 'observed', true);

select is(
  (select pricing_known from public.gateway_usage_events where request_id = 'gwm-req-2'),
  false,
  'a completed-but-unpriced request reads pricing_known = false, not free');
select is(
  (select cost_micro_usd + estimated_cost_micro_usd
     from public.gateway_usage_events where request_id = 'gwm-req-2'),
  0::bigint,
  'the unpriced request has no computed cost (surfaced as unpriced, not $0)');

-- Case C: a failed attempt settled with a sanitized reason persists it on the
-- attempt AND, on finalize, on the usage event alongside the failure class.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwm-req-3', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwm-att-3', 'gwm-req-3', '66000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'host_managed',
  'dispatched', now(), 1000000, 2000000, now());

select public.gateway_settle_attempt(
  'gwm-att-3', 'failed', 'provider_internal', 5, null, 0, null, 'observed', true,
  null, 'Anthropic returned a 529 overloaded error.');

select is(
  (select error_message from public.gateway_attempts where attempt_id = 'gwm-att-3'),
  'Anthropic returned a 529 overloaded error.',
  'settle persists the sanitized reason onto the attempt');
select is(
  (select error_message from public.gateway_usage_events where request_id = 'gwm-req-3'),
  'Anthropic returned a 529 overloaded error.',
  'settle then finalize lands the reason on the usage event');
select is(
  (select failure_class from public.gateway_usage_events where request_id = 'gwm-req-3'),
  'provider_internal',
  'the winning attempt failure class rides onto the usage event');

-- Case D: a pre-dispatch failure has no attempt, so finish_request stores the
-- reason on the request and finalize surfaces it (with no spend, priced-known).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwm-req-4', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');

select public.gateway_finish_request(
  'gwm-req-4', '66000000-0000-0000-0000-000000000001', 'failed',
  'internal', 'No route could serve this request.');

select is(
  (select failure_class from public.gateway_usage_events where request_id = 'gwm-req-4'),
  'internal',
  'a pre-dispatch failure surfaces its class from the request');
select is(
  (select error_message from public.gateway_usage_events where request_id = 'gwm-req-4'),
  'No route could serve this request.',
  'a pre-dispatch failure surfaces its sanitized reason from the request');
select is(
  (select pricing_known from public.gateway_usage_events where request_id = 'gwm-req-4'),
  true,
  'a pre-dispatch failure had no spend, so it is priced-known, not unpriced');

-- Case E: a FAILED request with NO observed usage on a FULLY PRICED route --
-- the ordinary failure path (ledger.finish_attempt passes usage None ->
-- usage_source='unknown', every token count null). gateway_attempt_cost_micro_usd
-- returns null with no usage, so estimated_cost_micro_usd is null; the event must
-- STILL read pricing_known = true (the route is priced; the real cost is $0.00),
-- never "unpriced". This is the regression 20260821220000 fixes.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwm-req-5', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwm-att-5', 'gwm-req-5', '66000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'host_managed',
  'dispatched', now(), 1000000, 2000000, now());

-- Mirror the ledger's FAILURE path exactly: no usage, usage_source='unknown'.
select public.gateway_settle_attempt(
  'gwm-att-5', 'failed', 'provider_internal', null, null, null, null, 'unknown',
  true, null, 'Provider connection reset.');

select is(
  (select pricing_known from public.gateway_usage_events where request_id = 'gwm-req-5'),
  true,
  'a failed call on a priced route is pricing_known (real cost $0), not unpriced');
select is(
  (select cost_micro_usd + estimated_cost_micro_usd
     from public.gateway_usage_events where request_id = 'gwm-req-5'),
  0::bigint,
  'the failed call settled with a real cost of 0, surfaced as $0.00 not unpriced');

select finish();

rollback;
