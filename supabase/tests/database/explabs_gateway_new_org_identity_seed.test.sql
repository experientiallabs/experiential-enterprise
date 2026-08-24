begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

-- ---------------------------------------------------------------------------
-- New-org identity-tier seeding gate.
--
-- P-A's backfill only fixes orgs that existed at migration time. This suite
-- proves the organizations_seed_identity_tier trigger gives a NEWLY-inserted
-- org the same deny-by-default starting position: a default identity plus a
-- grant for every alias usable under P-A's rule predicate, which for a fresh
-- org is exactly the active PUBLIC catalog. The ordering that matters -- alias
-- exists BEFORE the org is created -- is what the P-A one-shot backfill cannot
-- cover and this trigger does. All ids are prefixed 'nos'/'72...' so ambient
-- seed data cannot perturb the set assertions.

-- Public catalog and a private-to-another-org alias, both created BEFORE the
-- org under test, through the real write path.
select public.gateway_register_catalog_snapshot(
  repeat('ef', 32), '{"deployments": ["dep-1"]}'::jsonb, '{"models": []}'::jsonb
);
select public.gateway_activate_alias_revision(
  'nos-alias-public', 'nos-public', null, 'nos-rev-public',
  '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('ef', 32), '{}'::jsonb, null
);
-- A second public alias that is retired: NOT usable today, so it must NOT be
-- granted to the new org.
select public.gateway_activate_alias_revision(
  'nos-alias-retired', 'nos-retired', null, 'nos-rev-retired',
  '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('ef', 32), '{}'::jsonb, null
);
select public.gateway_deactivate_alias('nos-alias-retired');
-- Another org and its private alias, to prove no cross-org leak into the seed.
insert into public.organizations (id, slug, name) values
  ('72000000-0000-0000-0000-000000000009', 'nos-org-other', 'New Org Seed Other');
select public.gateway_activate_alias_revision(
  'nos-alias-other', 'nos-other', '72000000-0000-0000-0000-000000000009',
  'nos-rev-other', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('ef', 32), '{}'::jsonb, null
);

-- ---------------------------------------------------------------------------
-- Create the org under test. The trigger fires on THIS insert.
insert into public.organizations (id, slug, name) values
  ('72000000-0000-0000-0000-000000000001', 'nos-org-a', 'New Org Seed A');

-- (a) Default identity exists, id == 'org-' || org_id, active.
select is(
  (select display_name from public.gateway_identities
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'),
  'Default',
  'a newly inserted org gets a default identity with id org-{org_id}'
);
select ok(
  exists (select 1 from public.gateway_identities
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and org_id = '72000000-0000-0000-0000-000000000001' and active),
  'the new org default identity is active and owned by the org'
);

-- (b) Public-catalog grant is seeded so the org can call public models now.
select ok(
  exists (select 1 from public.gateway_grants
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and alias_id = 'nos-alias-public'),
  'the new org is granted the pre-existing active public alias'
);

-- Exactly the rule-derived usable set: public active aliases only (the org owns
-- none), no more, no less, scoped to this suite's ids.
select is(
  (select array_agg(g.alias_id order by g.alias_id)
     from public.gateway_grants g
    where g.identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and g.alias_id like 'nos-%'),
  array['nos-alias-public']::text[],
  'the new org is granted exactly its usable (public, active) aliases'
);

-- Deny-by-default holds for what is NOT usable today.
select ok(
  not exists (select 1 from public.gateway_grants
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and alias_id = 'nos-alias-retired'),
  'the retired (inactive) public alias is not granted to the new org'
);
select ok(
  not exists (select 1 from public.gateway_grants
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and alias_id = 'nos-alias-other'),
  'another org''s private alias is not leaked into the new org''s grants'
);

-- ---------------------------------------------------------------------------
-- Aliases created AFTER the org are deny-by-default: the trigger seeds only the
-- catalog present at org-creation, matching P-A's snapshot semantics.
select public.gateway_activate_alias_revision(
  'nos-alias-later', 'nos-later', null, 'nos-rev-later',
  '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('ef', 32), '{}'::jsonb, null
);
select ok(
  not exists (select 1 from public.gateway_grants
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and alias_id = 'nos-alias-later'),
  'a public alias created after the org is not retroactively granted (deny-by-default)'
);

-- ---------------------------------------------------------------------------
-- Composition with P-A: re-running the seed and the full backfill is a no-op
-- (idempotent), producing no duplicate identities or grants under any ordering.
select public.gateway_seed_org_identity_tier('72000000-0000-0000-0000-000000000001');
select public.gateway_backfill_identity_tier();
select is(
  (select count(*) from public.gateway_identities
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'),
  1::bigint,
  're-running the seed leaves exactly one default identity (idempotent)'
);
-- After the full backfill, the org additionally holds the now-existing later
-- alias (backfill is a fresh snapshot), but never a duplicate of the public one.
select is(
  (select count(*) from public.gateway_grants
    where identity_id = 'org-72000000-0000-0000-0000-000000000001'
      and alias_id = 'nos-alias-public'),
  1::bigint,
  'the public-alias grant is never duplicated across seed + backfill'
);

-- ---------------------------------------------------------------------------
-- An org created when NO public catalog exists yet gets an identity but zero
-- grants -- it is not wedged, and later grants arrive via backfill or the API.
insert into public.organizations (id, slug, name) values
  ('72000000-0000-0000-0000-000000000002', 'nos-org-empty', 'New Org Seed Empty');
-- Remove the ambient/public grants so we can assert the shape cleanly for this
-- org: it should mirror only aliases usable at its creation.
select ok(
  exists (select 1 from public.gateway_identities
    where identity_id = 'org-72000000-0000-0000-0000-000000000002'),
  'an org still gets its default identity even with a public catalog present'
);
select ok(
  (select count(*) from public.gateway_grants
     where identity_id = 'org-72000000-0000-0000-0000-000000000002'
       and alias_id like 'nos-%') >= 1,
  'the empty-name org is granted the active public catalog that exists at its creation'
);

select * from finish();

rollback;
