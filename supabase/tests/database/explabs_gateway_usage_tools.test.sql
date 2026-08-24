-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Tool-call telemetry on the canonical usage stream, schema half
-- (20260821110000_gateway_usage_tools.sql): the tool_names carrier flows from
-- the settled attempt through gateway_finalize_usage onto the usage event,
-- names only, with NULL and empty collapsing to the same "not captured" state.
-- The tenant read (list_gateway_usage_events.tools_used) is covered on the
-- gateway usage reads surface that owns that function.

begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- Storage shape.
select has_column('public', 'gateway_usage_events', 'tools_used',
  'gateway_usage_events carries tools_used');
select col_type_is('public', 'gateway_usage_events', 'tools_used', 'text[]',
  'tools_used is a text array');
select col_is_null('public', 'gateway_usage_events', 'tools_used',
  'tools_used is nullable (NULL = not captured)');
select has_column('public', 'gateway_attempts', 'tool_names',
  'gateway_attempts carries the tool_names finalize copies onto the event');

-- Fixtures: one org and key; each case gets its own request + winning attempt.
insert into public.organizations (id, slug, name) values
  ('63000000-0000-0000-0000-000000000001', 'pgtap-gwtools', 'pgTAP GW Tools');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('63000000-0000-0000-0000-000000000011', '63000000-0000-0000-0000-000000000001',
   'gwtools', 'xpl_gwt', encode(sha256('gwtools'::bytea), 'hex'));

-- A settled, terminal request whose winning attempt already recorded two tool
-- names: gateway_finalize_usage must copy them onto the event.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
) values (
  'gwt-req-1', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '3 seconds', now() + interval '60 seconds',
  'completed', now());
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, input_tokens, output_tokens, usage_source,
  estimated_cost_micro_usd, tool_names, budget_period_start
) values (
  'gwt-att-1', 'gwt-req-1', '63000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'completed', now(), now(), 42, 7, 'observed', 1000, array['search', 'fetch'], now());

select public.gateway_finalize_usage('gwt-req-1');

select is(
  (select tools_used from public.gateway_usage_events where request_id = 'gwt-req-1'),
  array['search', 'fetch'],
  'finalize copies the winning attempt tool names onto the usage event');

-- A request whose winning attempt recorded no tool names: tools_used stays NULL.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
) values (
  'gwt-req-2', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '3 seconds', now() + interval '60 seconds',
  'completed', now());
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, input_tokens, output_tokens, usage_source,
  estimated_cost_micro_usd, tool_names, budget_period_start
) values (
  'gwt-att-2', 'gwt-req-2', '63000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'completed', now(), now(), 10, 3, 'observed', 500, null, now());

select public.gateway_finalize_usage('gwt-req-2');

select is(
  (select tools_used from public.gateway_usage_events where request_id = 'gwt-req-2'),
  null,
  'no tool activity leaves tools_used NULL');

-- The full settle wire: a dispatched attempt settled with p_tool_names lands
-- the names on the attempt AND, on finalize, on the usage event.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwt-req-3', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwt-att-3', 'gwt-req-3', '63000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'dispatched', now(), 1000000, 2000000, now());

select public.gateway_settle_attempt(
  'gwt-att-3', 'completed', null, 12, null, 4, null, 'observed', true,
  array['calculator']);

select is(
  (select tool_names from public.gateway_attempts where attempt_id = 'gwt-att-3'),
  array['calculator'],
  'settle persists p_tool_names onto the attempt');
select is(
  (select tools_used from public.gateway_usage_events where request_id = 'gwt-req-3'),
  array['calculator'],
  'settle then finalize lands tool names on the usage event');

-- Settling with no tool names leaves the attempt and event NULL (the default,
-- defensive path the platform takes until WMO surfaces names).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'gwt-req-4', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), now() - interval '1 second', now() + interval '60 seconds');
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwt-att-4', 'gwt-req-4', '63000000-0000-0000-0000-000000000001', 0, 0, 'dep-1',
  'anthropic', 'claude-haiku', 'pool-1', repeat('ab', 32), 'customer_managed',
  'dispatched', now(), 1000000, 2000000, now());

select public.gateway_settle_attempt(
  'gwt-att-4', 'completed', null, 5, null, 2, null, 'observed', true);

select is(
  (select tool_names from public.gateway_attempts where attempt_id = 'gwt-att-4'),
  null,
  'settle without p_tool_names leaves the attempt tool_names NULL');
select is(
  (select tools_used from public.gateway_usage_events where request_id = 'gwt-req-4'),
  null,
  'the defensive default keeps tools_used NULL end to end');

select finish();

rollback;
