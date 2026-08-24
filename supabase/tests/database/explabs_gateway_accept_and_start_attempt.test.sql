begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- gateway_accept_and_start_attempt (migration 20260830100000): the money hot
-- path's fold. One security-definer call persists accepted authority AND does
-- the budget reservation + attempt insert atomically. The two inner functions
-- keep owning every guard (the fold is composition, so promo/budget/price
-- recompositions of gateway_start_attempt are inherited); this suite pins the
-- fold-specific contract: atomicity of the pair, replay of a retried RPC, and
-- rollback of BOTH writes on a money or authority rejection (no
-- accepted-authority row may exist without its reservation outcome).

-- ---------------------------------------------------------------------------
-- Fixtures: one funded org (signup grant covers the $1 reservation), one
-- drained org, keys reparented onto the trigger-seeded default identities,
-- uncapped key limits so no key cap masks the verdicts, and one alias
-- revision on a snapshot. Neither org has an admin membership, so the
-- pre-verify spend gate (P1025) never fires here; its own suite pins it.

insert into public.organizations (id, slug, name) values
  ('64000000-0000-0000-0000-000000000001', 'pgtap-fold-funded', 'pgTAP Fold Funded'),
  ('64000000-0000-0000-0000-000000000002', 'pgtap-fold-drained', 'pgTAP Fold Drained');
update public.organizations
   set billable_spend_usd = credit_granted_usd
 where id = '64000000-0000-0000-0000-000000000002';

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id) values
  ('64000000-0000-0000-0000-000000000011', '64000000-0000-0000-0000-000000000001',
   'k-fold', 'xpl_fld', encode(sha256('fold-k1'::bytea), 'hex'), null,
   'org-64000000-0000-0000-0000-000000000001'),
  ('64000000-0000-0000-0000-000000000012', '64000000-0000-0000-0000-000000000002',
   'k-fold-drained', 'xpl_flx', encode(sha256('fold-k2'::bytea), 'hex'), null,
   'org-64000000-0000-0000-0000-000000000002'),
  ('64000000-0000-0000-0000-000000000013', '64000000-0000-0000-0000-000000000001',
   'k-fold-revoked', 'xpl_flr', encode(sha256('fold-k3'::bytea), 'hex'), null,
   'org-64000000-0000-0000-0000-000000000001');
update public.api_keys set revoked_at = now()
 where id = '64000000-0000-0000-0000-000000000013';

insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
select id, null, null from public.api_keys
 where org_id in ('64000000-0000-0000-0000-000000000001',
                  '64000000-0000-0000-0000-000000000002');

insert into public.gateway_catalog_snapshots (catalog_sha256, document, models_document)
  values (repeat('ef', 32), '{}'::jsonb, '{}'::jsonb);
insert into public.gateway_aliases (alias_id, alias_name, org_id, active, origin)
  values ('alias-fold', 'folded', '64000000-0000-0000-0000-000000000001', true, 'named');
insert into public.gateway_alias_revisions (
  revision_id, alias_id, target, catalog_sha256, provider_connection_revisions
) values (
  'rev-fold', 'alias-fold', '{"pool_id":"pool-fold"}'::jsonb, repeat('ef', 32), '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- 1. Happy path: one call lands the request row (null caller operation, the
--    accept-time deadline) and the reserved attempt together.

select is(
  (select pg_catalog.count(*) from public.gateway_accept_and_start_attempt(
    'fold-r1', '64000000-0000-0000-0000-000000000001',
    '64000000-0000-0000-0000-000000000011', 'folded', 'rev-fold',
    'chat_completions', encode(sha256('fold-r1'::bytea), 'hex'),
    now() + interval '1 hour',
    0, 0, 'dep-fold', 'prov', 'm-fold', 'pool-fold', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'the combined call reserves and returns exactly one attempt id'
);

select is(
  (select requests.caller_operation_sha256 is null
     from public.gateway_requests requests where requests.request_id = 'fold-r1'),
  true,
  'the folded accept persists the request row with a null caller operation'
);

select is(
  (select pg_catalog.count(*) from public.gateway_attempts
    where request_id = 'fold-r1' and budget_reserved_micro_usd = 1000000),
  1::pg_catalog.int8,
  'the reservation commits in the same call as the accept'
);

-- ---------------------------------------------------------------------------
-- 2. Retried RPC (worker retry after a lost response): both inner functions
--    replay their receipts, so the same attempt id returns and nothing new
--    is written or reserved.

select is(
  (select attempt_id from public.gateway_accept_and_start_attempt(
    'fold-r1', '64000000-0000-0000-0000-000000000001',
    '64000000-0000-0000-0000-000000000011', 'folded', 'rev-fold',
    'chat_completions', encode(sha256('fold-r1'::bytea), 'hex'),
    now() + interval '1 hour',
    0, 0, 'dep-fold', 'prov', 'm-fold', 'pool-fold', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  (select attempt_id from public.gateway_attempts where request_id = 'fold-r1'),
  'a retried combined RPC replays the same attempt id'
);

select is(
  (select pg_catalog.count(*)::pg_catalog.int8 from public.gateway_attempts
    where request_id = 'fold-r1'),
  1::pg_catalog.int8,
  'a retried combined RPC never double-reserves'
);

-- ---------------------------------------------------------------------------
-- 3. Money rejection rolls back BOTH writes: the drained org's reservation
--    raises P1010 and no accepted-authority row survives.

select throws_ok(
  $$select public.gateway_accept_and_start_attempt(
    'fold-r2', '64000000-0000-0000-0000-000000000002',
    '64000000-0000-0000-0000-000000000012', 'folded', 'rev-fold',
    'chat_completions', encode(sha256('fold-r2'::bytea), 'hex'),
    now() + interval '1 hour',
    0, 0, 'dep-fold', 'prov', 'm-fold', 'pool-fold', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  'P1010',
  null,
  'a drained org is rejected at the fold with the balance SQLSTATE'
);

select is(
  (select pg_catalog.count(*) from public.gateway_requests where request_id = 'fold-r2'),
  0::pg_catalog.int8,
  'a rejected fold leaves no accepted-authority row behind'
);

-- ---------------------------------------------------------------------------
-- 4. Revoked-key rejection is equally atomic (42501 from the accept half).

select throws_ok(
  $$select public.gateway_accept_and_start_attempt(
    'fold-r3', '64000000-0000-0000-0000-000000000001',
    '64000000-0000-0000-0000-000000000013', 'folded', 'rev-fold',
    'chat_completions', encode(sha256('fold-r3'::bytea), 'hex'),
    now() + interval '1 hour',
    0, 0, 'dep-fold', 'prov', 'm-fold', 'pool-fold', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  '42501',
  null,
  'a revoked key is rejected by the folded accept gate'
);

select is(
  (select pg_catalog.count(*) from public.gateway_requests where request_id = 'fold-r3'),
  0::pg_catalog.int8,
  'a revoked-key fold leaves no accepted-authority row behind'
);

-- ---------------------------------------------------------------------------
-- 5. Grants: server-internal, service-role only, like every gateway_* RPC.

select is(
  pg_catalog.has_function_privilege(
    'anon',
    'public.gateway_accept_and_start_attempt(pg_catalog.text, pg_catalog.uuid,'
    || ' pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,'
    || ' pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int4, pg_catalog.int4,'
    || ' pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,'
    || ' pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,'
    || ' pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.int8,'
    || ' pg_catalog.int8)',
    'execute'
  ),
  false,
  'anon may not execute the fold RPC'
);

select * from finish();

rollback;
