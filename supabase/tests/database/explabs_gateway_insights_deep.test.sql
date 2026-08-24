begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- Part A. WRITE WIRE. Drive gateway_finalize_usage over a real request with
-- two attempts and assert the four deep-telemetry columns land on the event.
-- The winning attempt (max ordinal) supplies the token breakdown and the
-- generation span; the FIRST attempt (min started_at) fixes routing overhead.

insert into public.organizations (id, slug, name) values
  ('63000000-0000-0000-0000-000000000001', 'pgtap-gwi-a', 'pgTAP GW Insights A'),
  ('63000000-0000-0000-0000-000000000002', 'pgtap-gwi-b', 'pgTAP GW Insights B');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('63000000-0000-0000-0000-000000000011', '63000000-0000-0000-0000-000000000001',
   'gwi-fin', 'xpl_gwif', encode(sha256('gwi-fin'::bytea), 'hex')),
  ('63000000-0000-0000-0000-000000000021', '63000000-0000-0000-0000-000000000002',
   'gwi-app-1', 'xpl_gwi1', encode(sha256('gwi-app-1'::bytea), 'hex')),
  ('63000000-0000-0000-0000-000000000022', '63000000-0000-0000-0000-000000000002',
   'gwi-app-2', 'xpl_gwi2', encode(sha256('gwi-app-2'::bytea), 'hex'));

insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
) values (
  'req-fin1', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'haiku', 'rev-1', 'chat_completions',
  repeat('ab', 32), '2026-08-20 10:00:00+00', '2026-08-20 10:01:00+00',
  'completed', '2026-08-20 10:00:09+00'
);

-- First attempt (ordinal 0): failed, dispatched 2s after acceptance -> routing
-- overhead 2000 ms comes from THIS row's started_at (the minimum).
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth,
  deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
  billing_source, state, started_at, terminal_at, budget_period_start,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens
) values (
  'att-fin1-0', 'req-fin1', '63000000-0000-0000-0000-000000000001', 0, 0,
  'dep-x', 'anthropic', 'claude-haiku', 'pool-x', repeat('ab', 32),
  'host_managed', 'failed', '2026-08-20 10:00:02+00', '2026-08-20 10:00:03+00',
  '2026-08-20', 0, 0, 0, 0
);
-- Winning attempt (ordinal 1): completed, generation span 5s (4s..9s) ->
-- generation_duration_ms 5000; carries the token breakdown.
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth,
  deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
  billing_source, state, started_at, terminal_at, budget_period_start,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens
) values (
  'att-fin1-1', 'req-fin1', '63000000-0000-0000-0000-000000000001', 1, 1,
  'dep-y', 'anthropic', 'claude-haiku', 'pool-y', repeat('ab', 32),
  'host_managed', 'completed', '2026-08-20 10:00:04+00', '2026-08-20 10:00:09+00',
  '2026-08-20', 100, 30, 50, 15
);

select public.gateway_finalize_usage('req-fin1');

select results_eq(
  $$select reasoning_tokens, cached_input_tokens, generation_duration_ms,
           routing_overhead_ms, input_tokens, output_tokens
      from public.gateway_usage_events where request_id = 'req-fin1'$$,
  $$values (15::bigint, 30::bigint, 5000, 2000, 100::bigint, 50::bigint)$$,
  'finalize copies the winning attempt token breakdown and derives durations'
);

-- ---------------------------------------------------------------------------
-- Part B. READ HALF. Directly-inserted events across models, providers, keys,
-- and hours for org B. (Reads are under test; the append-only trigger only
-- blocks update/delete.) One pre-dispatch failure (null durations, null
-- provider) proves duration/rate aggregates ignore it. One event's key id has
-- no api_keys row (deleted-after-settlement attribution snapshot).

insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
)
select
  ids.request_id, '63000000-0000-0000-0000-000000000002', ids.api_key_id,
  ids.alias, 'rev-1', 'chat_completions', repeat('cd', 32),
  ids.created_at - interval '1 second', ids.created_at + interval '60 seconds',
  ids.status, ids.created_at
from (values
  ('req-b1', '63000000-0000-0000-0000-000000000021'::uuid, 'haiku',
   'completed', '2026-08-20 10:05:00+00'::timestamptz),
  ('req-b2', '63000000-0000-0000-0000-000000000021'::uuid, 'haiku',
   'completed', '2026-08-20 10:20:00+00'::timestamptz),
  ('req-b3', '63000000-0000-0000-0000-000000000022'::uuid, 'sonnet',
   'expired_before_dispatch', '2026-08-20 10:40:00+00'::timestamptz),
  ('req-b4', '63000000-0000-0000-0000-000000000022'::uuid, 'sonnet',
   'completed', '2026-08-20 11:05:00+00'::timestamptz),
  ('req-b5', null::uuid, 'haiku',
   'completed', '2026-08-20 12:05:00+00'::timestamptz)
) as ids(request_id, api_key_id, alias, status, created_at);

insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane,
  input_tokens, output_tokens, reasoning_tokens, cached_input_tokens,
  cost_micro_usd, estimated_cost_micro_usd, generation_duration_ms,
  routing_overhead_ms, latency_ms, status, attempt_count, day, created_at
) values
  ('req-b1', '63000000-0000-0000-0000-000000000002',
   '63000000-0000-0000-0000-000000000021', 'haiku', 'anthropic',
   'platform_funded', 100, 200, 10, 40, 3000, 0, 2000, 100, 2200,
   'completed', 1, '2026-08-20', '2026-08-20 10:05:00+00'),
  ('req-b2', '63000000-0000-0000-0000-000000000002',
   '63000000-0000-0000-0000-000000000021', 'haiku', 'anthropic',
   'platform_funded', 100, 200, 10, 60, 3000, 0, 2000, 300, 2500,
   'completed', 1, '2026-08-20', '2026-08-20 10:20:00+00'),
  -- Pre-dispatch failure: no provider, no durations. Must not drag any
  -- duration/rate average or the tok/s series.
  ('req-b3', '63000000-0000-0000-0000-000000000002',
   '63000000-0000-0000-0000-000000000022', 'sonnet', null,
   null, 50, 0, 0, 0, 0, 0, null, null, null,
   'expired_before_dispatch', 0, '2026-08-20', '2026-08-20 10:40:00+00'),
  ('req-b4', '63000000-0000-0000-0000-000000000002',
   '63000000-0000-0000-0000-000000000022', 'sonnet', 'openai',
   'pass_through', 200, 600, 50, 100, 0, 9000, 3000, 200, 3300,
   'completed', 1, '2026-08-20', '2026-08-20 11:05:00+00'),
  -- Attribution snapshot for a key whose api_keys row no longer exists.
  ('req-b5', '63000000-0000-0000-0000-000000000002',
   '63000000-0000-0000-0000-000000000029', 'haiku', 'anthropic',
   'platform_funded', 10, 20, 1, 5, 500, 0, 500, 50, 600,
   'completed', 1, '2026-08-20', '2026-08-20 12:05:00+00');

-- 1. Windowed metrics grouped by model: cache-hit rate, aggregate tok/s, and
--    the reasoning slice. haiku sums req-b1, req-b2, req-b5.
select results_eq(
  $$select request_count, completed_count, error_count, reasoning_tokens,
           cache_hit_rate, tokens_per_second
      from public.gateway_insights_metrics(
        '63000000-0000-0000-0000-000000000002', 'model'
      ) where bucket_key = 'haiku'$$,
  $$values (3::bigint, 3::bigint, 0::bigint, 21::bigint,
            (105::numeric / 210), (420::numeric / 4.5))$$,
  'model grouping yields cache-hit rate, tok/s, and the reasoning slice'
);

-- sonnet: one expired (null duration) + one completed. The rate uses the
-- completed row only; the error is counted.
select results_eq(
  $$select error_count, completion_tokens, cache_hit_rate, tokens_per_second
      from public.gateway_insights_metrics(
        '63000000-0000-0000-0000-000000000002', 'model'
      ) where bucket_key = 'sonnet'$$,
  $$values (1::bigint, 600::bigint, (100::numeric / 250), (600::numeric / 3))$$,
  'a pre-dispatch failure is counted but never enters the tok/s denominator'
);

-- 2. Provider grouping buckets the no-dispatch rows under a sentinel key.
select is(
  (select count(*) from public.gateway_insights_metrics(
    '63000000-0000-0000-0000-000000000002', 'provider'
  )),
  3::bigint,
  'provider grouping separates anthropic, openai, and the no-dispatch bucket'
);

select is(
  (select request_count from public.gateway_insights_metrics(
    '63000000-0000-0000-0000-000000000002', 'provider'
  ) where bucket_key = '(no dispatch)'),
  1::bigint,
  'requests that never dispatched fall in the no-dispatch provider bucket'
);

-- 3. An unknown grouping dimension is refused, never silently emptied.
select throws_ok(
  $$select * from public.gateway_insights_metrics(
    '63000000-0000-0000-0000-000000000002', 'region'
  )$$,
  '22023',
  null,
  'an unknown group_by is refused'
);

-- 4. tok/s over time: one hourly bucket per dispatched hour; the pre-dispatch
--    failure contributes no bucket.
select is(
  (select count(*) from public.gateway_insights_tokens_per_second(
    '63000000-0000-0000-0000-000000000002', null, null, 3600
  )),
  3::bigint,
  'tok/s series buckets the three dispatched hours (10:00, 11:00, 12:00)'
);

select results_eq(
  $$select request_count, completion_tokens, generation_ms, tokens_per_second
      from public.gateway_insights_tokens_per_second(
        '63000000-0000-0000-0000-000000000002', null, null, 3600
      ) where bucket_start = '2026-08-20 10:00:00+00'$$,
  $$values (2::bigint, 400::bigint, 4000::bigint, (400::numeric / 4))$$,
  'the 10:00 bucket divides completion tokens by generation seconds'
);

select is(
  (select count(*) from public.gateway_insights_tokens_per_second(
    '63000000-0000-0000-0000-000000000002', null, null, 3600, 'sonnet'
  )),
  1::bigint,
  'the alias filter narrows the tok/s series'
);

-- 5. Top apps by API key label, highest traffic first, org-scoped.
select is(
  (select count(*) from public.gateway_insights_top_apps(
    '63000000-0000-0000-0000-000000000002'
  )),
  3::bigint,
  'top apps groups by attribution key (two live keys plus one deleted)'
);

select is(
  (select app_label from public.gateway_insights_top_apps(
    '63000000-0000-0000-0000-000000000002'
  ) where api_key_id = '63000000-0000-0000-0000-000000000029'),
  null::text,
  'a key deleted after settlement keeps its history under a null app label'
);

select results_eq(
  $$select request_count, prompt_tokens, completion_tokens, reasoning_tokens
      from public.gateway_insights_top_apps(
        '63000000-0000-0000-0000-000000000002'
      ) where api_key_id = '63000000-0000-0000-0000-000000000021'$$,
  $$values (2::bigint, 200::bigint, 400::bigint, 20::bigint)$$,
  'a live key rolls up its request count and token breakdown'
);

select * from finish();
rollback;
