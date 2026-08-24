-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Time-to-first-token telemetry (20260828220000_gateway_ttft.sql): the
-- runtime-reported first_token_at flows from gateway_settle_attempt onto the
-- attempt, gateway_finalize_usage derives ttft_ms (winning attempt started_at
-- -> first_token_at, ms) onto the usage event, and the tenant per-request read
-- (list_gateway_usage_events) surfaces it. NULL means "no first token
-- observed" and is never rendered as zero, so non-streaming and pre-capture
-- rows cannot drag averages down.

begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

-- Storage shape.
select has_column('public', 'gateway_attempts', 'first_token_at',
  'gateway_attempts carries first_token_at');
select col_type_is('public', 'gateway_attempts', 'first_token_at',
  'timestamp with time zone', 'first_token_at is a timestamptz');
select col_is_null('public', 'gateway_attempts', 'first_token_at',
  'first_token_at is nullable (NULL = no first token observed)');
select has_column('public', 'gateway_usage_events', 'ttft_ms',
  'gateway_usage_events carries ttft_ms');
select col_type_is('public', 'gateway_usage_events', 'ttft_ms', 'integer',
  'ttft_ms is an int4');
select col_is_null('public', 'gateway_usage_events', 'ttft_ms',
  'ttft_ms is nullable (NULL = no first token observed)');

-- Fixtures: one org and key; each case gets its own request + winning attempt.
insert into public.organizations (id, slug, name) values
  ('64000000-0000-0000-0000-000000000001', 'pgtap-gwttft', 'pgTAP GW TTFT');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('64000000-0000-0000-0000-000000000011', '64000000-0000-0000-0000-000000000001',
   'gwttft', 'xpl_gwf', encode(sha256('gwttft'::bytea), 'hex'));

-- The full settle wire: a dispatched attempt settled with p_first_token_at
-- lands the timestamp on the attempt AND, on finalize, the derived ttft_ms on
-- the usage event (first token 450ms after dispatch).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwf-req-1', '64000000-0000-0000-0000-000000000001',
  '64000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '3 seconds', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwf-att-1', 'gwf-req-1', '64000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'dispatched', now() - interval '2 seconds', 1000000, 2000000, now());

select public.gateway_settle_attempt(
  'gwf-att-1', 'completed', null, 12, null, 4, null, 'observed', true,
  null, null,
  (select started_at + interval '450 milliseconds'
     from public.gateway_attempts where attempt_id = 'gwf-att-1'));

select is(
  (select first_token_at from public.gateway_attempts where attempt_id = 'gwf-att-1'),
  (select started_at + interval '450 milliseconds'
     from public.gateway_attempts where attempt_id = 'gwf-att-1'),
  'settle persists p_first_token_at onto the attempt');
select is(
  (select ttft_ms from public.gateway_usage_events where request_id = 'gwf-req-1'),
  450,
  'finalize derives ttft_ms = first_token_at - started_at on the usage event');

-- Settling without p_first_token_at (a not-yet-upgraded worker, a pre-dispatch
-- failure, or an engine with no streaming observation) leaves NULL end to end.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwf-req-2', '64000000-0000-0000-0000-000000000001',
  '64000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwf-att-2', 'gwf-req-2', '64000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'dispatched', now(), 1000000, 2000000, now());

select public.gateway_settle_attempt(
  'gwf-att-2', 'completed', null, 5, null, 2, null, 'observed', true);

select is(
  (select ttft_ms from public.gateway_usage_events where request_id = 'gwf-req-2'),
  null,
  'no first token observed keeps ttft_ms NULL end to end (never zero)');

-- Clock skew: a first token stamped BEFORE dispatch clamps to 0 rather than
-- going negative (the event column carries a >= 0 check).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwf-req-3', '64000000-0000-0000-0000-000000000001',
  '64000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwf-att-3', 'gwf-req-3', '64000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'dispatched', now(), 1000000, 2000000, now());

select public.gateway_settle_attempt(
  'gwf-att-3', 'completed', null, 5, null, 2, null, 'observed', true,
  null, null,
  (select started_at - interval '5 milliseconds'
     from public.gateway_attempts where attempt_id = 'gwf-att-3'));

select is(
  (select ttft_ms from public.gateway_usage_events where request_id = 'gwf-req-3'),
  0,
  'a first token stamped before dispatch clamps ttft_ms to 0, never negative');

-- The tenant per-request read surfaces the new column.
select is(
  (select events.ttft_ms from public.list_gateway_usage_events(
     '64000000-0000-0000-0000-000000000001') events
    where events.request_id = 'gwf-req-1'),
  450,
  'list_gateway_usage_events projects ttft_ms');

select finish();

rollback;
