begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- ---------------------------------------------------------------------------
-- Fixtures: one accepted request with one dispatched pass-through attempt.

insert into public.organizations (id, slug, name) values
  ('62000000-0000-0000-0000-000000000001', 'pgtap-gw-route-ctx', 'pgTAP Route Ctx');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('62000000-0000-0000-0000-000000000011', '62000000-0000-0000-0000-000000000001',
   'gw-rc', 'xpl_gwrc', encode(sha256('gw-rc'::bytea), 'hex'), null);

select public.gateway_register_catalog_snapshot(
  repeat('62', 32), '{"deployments": ["dep-rc"]}'::jsonb, '{"models": []}'::jsonb
);

select public.gateway_activate_alias_revision(
  'alias-route-ctx', 'model-route-ctx', null, 'revision-route-ctx',
  '{"kind": "direct", "pool_id": "pool-route-ctx"}'::jsonb,
  repeat('62', 32), '{}'::jsonb, null, false
);

select public.gateway_accept_request(
  'request-route-ctx', '62000000-0000-0000-0000-000000000001',
  '62000000-0000-0000-0000-000000000011', 'model-route-ctx',
  'revision-route-ctx', 'chat_completions', repeat('ab', 32), null,
  clock_timestamp() + interval '120 seconds'
);

create temporary table rc_ids (k text primary key, v text);
insert into rc_ids
select 'attempt', attempt_id from public.gateway_start_attempt(
  'request-route-ctx', '62000000-0000-0000-0000-000000000001', 0, 0,
  'dep-rc', 'openai-compatible', 'exact-rc', 'pool-route-ctx',
  repeat('62', 32), 'customer_managed', 'test', null,
  1000000, null, 2000000, null, 100
);

-- ---------------------------------------------------------------------------
-- 1-2. Route context lands on a dispatched attempt.

select lives_ok(
  format(
    'select public.gateway_record_route_context(%L, ''learned-route'', ''embedding-fallback'')',
    (select v from rc_ids where k = 'attempt')
  ),
  'route context is recorded on a dispatched attempt'
);

select is(
  (select route_reason || '/' || fallback_reason
   from public.gateway_attempts
   where attempt_id = (select v from rc_ids where k = 'attempt')),
  'learned-route/embedding-fallback',
  'both context codes are persisted'
);

-- ---------------------------------------------------------------------------
-- 3-4. Display-safety and unknown attempts are typed rejections.

select throws_ok(
  format(
    'select public.gateway_record_route_context(%L, %L, null)',
    (select v from rc_ids where k = 'attempt'), repeat('x', 513)
  ),
  '22023', 'gateway route context must be a short display-safe code',
  'over-long context is rejected'
);

select throws_ok(
  'select public.gateway_record_route_context(''attempt-missing'', ''r'', null)',
  '23514', 'gateway route context requires an existing attempt',
  'unknown attempt is rejected'
);

-- ---------------------------------------------------------------------------
-- 5-6. A settled attempt STILL accepts context: the writer is async now and
--      may land after settlement, and route context is display-only, so a
--      terminal attempt is a valid target (20260822150000).

select lives_ok(
  format(
    'select public.gateway_settle_attempt(%L, ''completed'', null, 10, null, 5, null, ''observed'', true)',
    (select v from rc_ids where k = 'attempt')
  ),
  'the dispatched attempt settles'
);

-- Write in its own statement so the assertion below reads the committed
-- effect (a same-statement CTE would see the pre-update snapshot).
select public.gateway_record_route_context(
  (select v from rc_ids where k = 'attempt'), 'late-route', null
);

select is(
  (select route_reason from public.gateway_attempts
    where attempt_id = (select v from rc_ids where k = 'attempt')),
  'late-route',
  'a settled attempt accepts late context (async writer may lose the race)'
);

select * from finish();

rollback;
