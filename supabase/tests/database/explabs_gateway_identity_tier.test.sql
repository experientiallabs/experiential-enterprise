begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

-- ---------------------------------------------------------------------------
-- Cutover-preservation gate for the identity tier (P-A).
--
-- The migration's backfill runs on an empty database, so we reconstruct a
-- realistic pre-cutover world here -- orgs, keys, and aliases exactly as the
-- int-p2 rule predicate sees them -- then invoke the SAME idempotent backfill
-- function the migration ran and assert that no access usable today is lost and
-- none is invented. All ids are prefixed 'idpa'/'71...' so ambient seed data
-- cannot perturb the set assertions.

insert into public.organizations (id, slug, name) values
  ('71000000-0000-0000-0000-000000000001', 'idpa-org-a', 'Identity PA Org A'),
  ('71000000-0000-0000-0000-000000000002', 'idpa-org-b', 'Identity PA Org B');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('71000000-0000-0000-0000-0000000000a1', '71000000-0000-0000-0000-000000000001',
   'idpa-ka1', 'xpl_idpaka1', encode(sha256('idpa-ka1'::bytea), 'hex'), null),
  ('71000000-0000-0000-0000-0000000000a2', '71000000-0000-0000-0000-000000000001',
   'idpa-ka2', 'xpl_idpaka2', encode(sha256('idpa-ka2'::bytea), 'hex'), null),
  ('71000000-0000-0000-0000-0000000000b1', '71000000-0000-0000-0000-000000000002',
   'idpa-kb1', 'xpl_idpakb1', encode(sha256('idpa-kb1'::bytea), 'hex'), null);

-- Catalog + aliases through the real write path, so "active with a current
-- revision" means exactly what it means in production.
select public.gateway_register_catalog_snapshot(
  repeat('cd', 32), '{"deployments": ["dep-1"]}'::jsonb, '{"models": []}'::jsonb
);

-- Public catalog alias (usable by every org).
select public.gateway_activate_alias_revision(
  'idpa-alias-shared', 'idpa-shared', null, 'idpa-rev-shared',
  '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('cd', 32), '{}'::jsonb, null
);
-- Org A's own alias (usable by A only).
select public.gateway_activate_alias_revision(
  'idpa-alias-a-only', 'idpa-a-only', '71000000-0000-0000-0000-000000000001',
  'idpa-rev-a', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('cd', 32), '{}'::jsonb, null
);
-- Org B's own alias (must NOT leak to A).
select public.gateway_activate_alias_revision(
  'idpa-alias-b-only', 'idpa-b-only', '71000000-0000-0000-0000-000000000002',
  'idpa-rev-b', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('cd', 32), '{}'::jsonb, null
);
-- Org A alias that is retired: inactive, so it is NOT usable today and must
-- NOT be granted.
select public.gateway_activate_alias_revision(
  'idpa-alias-a-retired', 'idpa-a-retired', '71000000-0000-0000-0000-000000000001',
  'idpa-rev-ar', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('cd', 32), '{}'::jsonb, null
);
select public.gateway_deactivate_alias('idpa-alias-a-retired');

-- Run the exact backfill the migration runs (idempotent; the migration already
-- ran it against the empty database at apply time).
select public.gateway_backfill_identity_tier();

-- ---------------------------------------------------------------------------
-- Default identity per org, id == today's synthetic 'org-' || org_id.

select is(
  (select display_name from public.gateway_identities
    where identity_id = 'org-71000000-0000-0000-0000-000000000001'),
  'Default',
  'org A has a default identity whose id is org-{org_id}'
);

select ok(
  exists (select 1 from public.gateway_identities
    where identity_id = 'org-71000000-0000-0000-0000-000000000002'
      and org_id = '71000000-0000-0000-0000-000000000002'
      and active),
  'org B has an active default identity'
);

-- ---------------------------------------------------------------------------
-- Every existing key is reparented to its org's default identity.

select is(
  (select identity_id from public.api_keys
    where id = '71000000-0000-0000-0000-0000000000a1'),
  'org-71000000-0000-0000-0000-000000000001',
  'key ka1 is reparented to org A default identity'
);

select is(
  (select identity_id from public.api_keys
    where id = '71000000-0000-0000-0000-0000000000a2'),
  'org-71000000-0000-0000-0000-000000000001',
  'key ka2 is reparented to org A default identity'
);

select is(
  (select identity_id from public.api_keys
    where id = '71000000-0000-0000-0000-0000000000b1'),
  'org-71000000-0000-0000-0000-000000000002',
  'key kb1 is reparented to org B default identity'
);

select is(
  (select count(*) from public.api_keys
    where org_id in (
      '71000000-0000-0000-0000-000000000001',
      '71000000-0000-0000-0000-000000000002'
    ) and identity_id is null),
  0::bigint,
  'no fixture key is left without an identity'
);

-- ---------------------------------------------------------------------------
-- Grant seed reproduces exactly today's rule-derived alias set: active aliases
-- in the org's namespace or the public catalog. No more, no less.

select is(
  (select array_agg(g.alias_id order by g.alias_id)
     from public.gateway_grants g
    where g.identity_id = 'org-71000000-0000-0000-0000-000000000001'
      and g.alias_id like 'idpa-%'),
  array['idpa-alias-a-only', 'idpa-alias-shared']::text[],
  'org A default identity is granted exactly its public+own active aliases'
);

select is(
  (select array_agg(g.alias_id order by g.alias_id)
     from public.gateway_grants g
    where g.identity_id = 'org-71000000-0000-0000-0000-000000000002'
      and g.alias_id like 'idpa-%'),
  array['idpa-alias-b-only', 'idpa-alias-shared']::text[],
  'org B default identity is granted exactly its public+own active aliases'
);

-- Cardinality form of the same invariant, independent of the enumerated set:
-- grant count equals the count of aliases usable under the pre-cutover rule.
select is(
  (select count(*) from public.gateway_grants g
    where g.identity_id = 'org-71000000-0000-0000-0000-000000000001'
      and g.alias_id like 'idpa-%'),
  (select count(*) from public.gateway_aliases a
    where a.alias_id like 'idpa-%'
      and a.active
      and (a.org_id is null or a.org_id = '71000000-0000-0000-0000-000000000001')),
  'org A grant count matches the rule-derived usable-alias count (no over/under-grant)'
);

-- ---------------------------------------------------------------------------
-- Sample (key, alias) pairs that authorize today still authorize after cutover:
-- the key's reparented identity holds a grant to the alias it can use today.

select ok(
  exists (select 1 from public.gateway_grants g
    join public.api_keys k on k.identity_id = g.identity_id
    where k.id = '71000000-0000-0000-0000-0000000000a1'
      and g.alias_id = 'idpa-alias-shared'),
  'ka1 keeps access to the public alias it can use today'
);

select ok(
  exists (select 1 from public.gateway_grants g
    join public.api_keys k on k.identity_id = g.identity_id
    where k.id = '71000000-0000-0000-0000-0000000000a1'
      and g.alias_id = 'idpa-alias-a-only'),
  'ka1 keeps access to its org-owned alias'
);

select ok(
  exists (select 1 from public.gateway_grants g
    join public.api_keys k on k.identity_id = g.identity_id
    where k.id = '71000000-0000-0000-0000-0000000000b1'
      and g.alias_id = 'idpa-alias-b-only'),
  'kb1 keeps access to its org-owned alias'
);

-- Deny-by-default holds for access that does NOT work today.
select ok(
  not exists (select 1 from public.gateway_grants g
    join public.api_keys k on k.identity_id = g.identity_id
    where k.id = '71000000-0000-0000-0000-0000000000a1'
      and g.alias_id = 'idpa-alias-b-only'),
  'ka1 is NOT granted org B''s private alias (no cross-org leak)'
);

select ok(
  not exists (select 1 from public.gateway_grants g
    where g.identity_id = 'org-71000000-0000-0000-0000-000000000001'
      and g.alias_id = 'idpa-alias-a-retired'),
  'the retired (inactive) alias is not granted'
);

-- A brand-new identity with no grants reads as fully denied.
insert into public.gateway_identities (identity_id, org_id, display_name)
  values ('idpa-fresh', '71000000-0000-0000-0000-000000000001', 'Fresh');
select is(
  (select count(*) from public.gateway_grants where identity_id = 'idpa-fresh'),
  0::bigint,
  'a freshly created identity starts deny-by-default (no grants)'
);

-- ---------------------------------------------------------------------------
-- Budgets: the backfill seeds none (absence = unlimited = today's behavior),
-- and the origin marker defaults to catalog on existing aliases.

select is(
  (select count(*) from public.gateway_budgets
    where org_id in (
      '71000000-0000-0000-0000-000000000001',
      '71000000-0000-0000-0000-000000000002'
    )),
  0::bigint,
  'no budgets are seeded (absence means unlimited, preserving today''s behavior)'
);

select is(
  (select count(*) from public.gateway_aliases
    where alias_id like 'idpa-%' and origin <> 'catalog'),
  0::bigint,
  'existing aliases default to origin=catalog'
);

-- ---------------------------------------------------------------------------
-- Budget scope CHECK mirrors MonthlyBudgetScope._require_scope_shape.

select throws_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, identity_id, alias_id, limit_micro_usd)
    values ('idpa-bad-1', '71000000-0000-0000-0000-000000000001', '2026-08',
            'identity', 'org-71000000-0000-0000-0000-000000000001',
            'idpa-alias-shared', 1000000)$$,
  '23514',
  null,
  'identity-scope budget rejects an alias_id it does not own'
);

select throws_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, identity_id, limit_micro_usd)
    values ('idpa-bad-2', '71000000-0000-0000-0000-000000000001', '2026-08',
            'team', 'org-71000000-0000-0000-0000-000000000001', 1000000)$$,
  '23514',
  null,
  'team-scope budget rejects an identity_id it does not own'
);

select throws_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, alias_id, limit_micro_usd)
    values ('idpa-bad-3', '71000000-0000-0000-0000-000000000001', '2026-08',
            'pool', 'idpa-alias-a-only', 1000000)$$,
  '23514',
  null,
  'pool-scope budget rejects a missing pool_id'
);

select throws_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, alias_id, pool_id, limit_micro_usd)
    values ('idpa-bad-4', '71000000-0000-0000-0000-000000000001', '2026-08',
            'deployment', 'idpa-alias-a-only', 'pool-1', 1000000)$$,
  '23514',
  null,
  'deployment-scope budget rejects a missing deployment_id'
);

select lives_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, identity_id, limit_micro_usd)
    values ('idpa-ok-identity', '71000000-0000-0000-0000-000000000001', '2026-08',
            'identity', 'org-71000000-0000-0000-0000-000000000001', 5000000)$$,
  'a well-formed identity-scope budget is accepted'
);

select lives_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, alias_id, pool_id, deployment_id,
       limit_micro_usd)
    values ('idpa-ok-deployment', '71000000-0000-0000-0000-000000000001', '2026-08',
            'deployment', 'idpa-alias-a-only', 'pool-1', 'dep-1', 5000000)$$,
  'a well-formed deployment-scope budget is accepted'
);

-- The identity_id ArtifactId shape is enforced (mirrors the control store).
select throws_ok(
  $$insert into public.gateway_identities (identity_id, org_id, display_name)
    values ('Bad-Id', '71000000-0000-0000-0000-000000000001', 'x')$$,
  '23514',
  null,
  'identity_id rejects non-ArtifactId shapes'
);

select * from finish();

rollback;
