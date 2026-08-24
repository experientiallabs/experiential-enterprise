-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Content-free request lineage (20260831110000_gateway_request_lineage.sql):
-- accept persists the prompt/conversation digests, finalize copies them onto
-- the usage event, the request log serves them, and gateway_usage_by_prompt
-- rolls the window up per (prompt digest, alias) excluding pre-lineage rows.

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

select has_column('public', 'gateway_requests', 'prompt_sha256',
  'gateway_requests carries prompt_sha256');
select has_column('public', 'gateway_requests', 'conversation_sha256',
  'gateway_requests carries conversation_sha256');
select has_column('public', 'gateway_requests', 'stable_prefix_chars',
  'gateway_requests carries stable_prefix_chars');
select has_column('public', 'gateway_usage_events', 'prompt_sha256',
  'gateway_usage_events carries prompt_sha256');
select has_column('public', 'gateway_usage_events', 'conversation_sha256',
  'gateway_usage_events carries conversation_sha256');
select has_column('public', 'gateway_usage_events', 'stable_prefix_chars',
  'gateway_usage_events carries stable_prefix_chars');

-- Fixtures: one org and key.
insert into public.organizations (id, slug, name) values
  ('68000000-0000-0000-0000-000000000001', 'pgtap-gwlin', 'pgTAP GW Lineage');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('68000000-0000-0000-0000-000000000011', '68000000-0000-0000-0000-000000000001',
   'gwlin', 'xpl_gwl', encode(sha256('gwlin'::bytea), 'hex'));

-- Accept with lineage: the trailing params land on the request row.
select public.gateway_accept_request(
  'gwl-req-1', '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000011', 'fable', 'rev-1',
  'chat_completions', encode(sha256('gwl-1'::bytea), 'hex'),
  null, now() + interval '1 hour',
  repeat('ab12', 16), repeat('11', 32), 8000
);

select results_eq(
  $$select prompt_sha256, conversation_sha256, stable_prefix_chars
      from public.gateway_requests where request_id = 'gwl-req-1'$$,
  format(
    $$values (%L::text, %L::text, 8000::bigint)$$,
    repeat('ab12', 16), repeat('11', 32)
  ),
  'accept persists the lineage digests on the request row');

-- A replayed accept without lineage (another worker holds no tracker entry)
-- stays a no-op: same content, no drift conflict, lineage untouched.
select lives_ok(
  format(
    $$select public.gateway_accept_request(
      'gwl-req-1', '68000000-0000-0000-0000-000000000001',
      '68000000-0000-0000-0000-000000000011', 'fable', 'rev-1',
      'chat_completions', %L, null, now() + interval '1 hour'
    )$$,
    encode(sha256('gwl-1'::bytea), 'hex')
  ),
  'a lineage-free replay of the same accepted content is a no-op');
select is(
  (select prompt_sha256 from public.gateway_requests where request_id = 'gwl-req-1'),
  repeat('ab12', 16),
  'the replay leaves the original lineage in place');

-- The nine-argument call shape (old worker during a roll) still accepts.
select public.gateway_accept_request(
  'gwl-req-2', '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000011', 'fable', 'rev-1',
  'chat_completions', encode(sha256('gwl-2'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select is(
  (select prompt_sha256 from public.gateway_requests where request_id = 'gwl-req-2'),
  null,
  'an accept without lineage params stores null lineage');

-- Finalize copies the request lineage onto the usage event.
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, input_rate_micro_usd, output_rate_micro_usd, budget_period_start
) values (
  'gwl-att-1', 'gwl-req-1', '68000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'anthropic', 'claude-fable', 'pool-1', repeat('ab', 32),
  'customer_managed', 'dispatched', now(), 10000000, 50000000, now());
select public.gateway_settle_attempt(
  'gwl-att-1', 'completed', null, 20000, 0, 500, null, 'observed', true);

select results_eq(
  $$select prompt_sha256, conversation_sha256, stable_prefix_chars
      from public.gateway_usage_events where request_id = 'gwl-req-1'$$,
  format(
    $$values (%L::text, %L::text, 8000::bigint)$$,
    repeat('ab12', 16), repeat('11', 32)
  ),
  'finalize copies the lineage onto the usage event');

-- The request log serves the lineage columns.
select results_eq(
  $$select cells.prompt_sha256, cells.stable_prefix_chars
      from public.list_gateway_usage_events(
        '68000000-0000-0000-0000-000000000001') as cells
     where cells.request_id = 'gwl-req-1'$$,
  format($$values (%L::text, 8000::bigint)$$, repeat('ab12', 16)),
  'list_gateway_usage_events returns the lineage columns');

-- Per-prompt rollup: two settled requests share one prompt across two
-- conversations; a lineage-free event never appears.
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state,
  terminal_at, prompt_sha256, conversation_sha256, stable_prefix_chars
) values (
  'gwl-req-3', '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000011', 'fable', 'rev-1', 'chat_completions',
  encode(sha256('gwl-3'::bytea), 'hex'), now() - interval '2 seconds',
  now() + interval '1 hour', 'completed', now(),
  repeat('ab12', 16), repeat('22', 32), 8000);
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cached_input_tokens, cost_micro_usd, estimated_cost_micro_usd,
  latency_ms, status, attempt_count, day, created_at,
  prompt_sha256, conversation_sha256, stable_prefix_chars
) values
  ('gwl-req-3', '68000000-0000-0000-0000-000000000001',
   '68000000-0000-0000-0000-000000000011', 'fable', 'anthropic',
   'pass_through', 21000, 400, 2000, 0, 200000, 700, 'completed', 1,
   current_date, now(), repeat('ab12', 16), repeat('22', 32), 8000);
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
) values (
  'gwl-req-4', '68000000-0000-0000-0000-000000000001',
  '68000000-0000-0000-0000-000000000011', 'fable', 'rev-1', 'chat_completions',
  encode(sha256('gwl-4'::bytea), 'hex'), now() - interval '2 seconds',
  now() + interval '1 hour', 'completed', now());
insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane, input_tokens,
  output_tokens, cost_micro_usd, estimated_cost_micro_usd, latency_ms,
  status, attempt_count, day, created_at
) values
  ('gwl-req-4', '68000000-0000-0000-0000-000000000001',
   '68000000-0000-0000-0000-000000000011', 'fable', 'anthropic',
   'pass_through', 100, 10, 0, 1000, 300, 'completed', 1,
   current_date, now());

select is(
  (select count(*) from public.gateway_usage_by_prompt(
    '68000000-0000-0000-0000-000000000001')),
  1::bigint,
  'the per-prompt rollup groups lineage-bearing events and skips the rest');
select results_eq(
  $$select cells.request_count, cells.conversation_count, cells.agent_count,
           cells.input_tokens, cells.cached_input_tokens,
           cells.stable_prefix_chars
      from public.gateway_usage_by_prompt(
        '68000000-0000-0000-0000-000000000001') as cells$$,
  $$values (2::bigint, 2::bigint, 1::bigint, 41000::bigint, 2000::bigint,
            8000::bigint)$$,
  'the rollup counts requests, conversations, agents, and token sums');
select is(
  (select count(*) from public.gateway_usage_by_prompt(
    '68000000-0000-0000-0000-000000000001',
    now() + interval '1 minute')),
  0::bigint,
  'the window lower bound applies to the rollup');

-- A malformed digest is refused at the column boundary.
select throws_ok(
  $$insert into public.gateway_requests (
      request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
      canonical_request_sha256, accepted_at, deadline_at, prompt_sha256
    ) values (
      'gwl-req-5', '68000000-0000-0000-0000-000000000001',
      '68000000-0000-0000-0000-000000000011', 'fable', 'rev-1',
      'chat_completions', repeat('ab', 32), now(), now() + interval '1 hour',
      'not-a-digest'
    )$$,
  '23514',
  null,
  'a non-hex prompt digest is refused');

select finish();

rollback;
