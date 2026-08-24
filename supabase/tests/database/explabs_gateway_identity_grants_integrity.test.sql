begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- ---------------------------------------------------------------------------
-- gateway_grants org integrity (F3). gateway_grants.org_id is denormalized;
-- before the composite FK a row whose org_id mismatched its identity's org
-- authorized at runtime (the control store joins on identity_id alone) while
-- staying invisible to the management UI (which lists by org_id). The
-- composite (org_id, identity_id) FK makes that state unrepresentable. All
-- ids are prefixed 'idgi'/'74...' so ambient seed data cannot perturb the
-- assertions.

insert into public.organizations (id, slug, name) values
  ('74000000-0000-0000-0000-000000000001', 'idgi-org-a', 'Grants Integrity Org A'),
  ('74000000-0000-0000-0000-000000000002', 'idgi-org-b', 'Grants Integrity Org B');

insert into public.gateway_identities (identity_id, org_id, display_name)
values ('idgi-ident-a', '74000000-0000-0000-0000-000000000001', 'Org A identity');

insert into public.gateway_aliases (alias_id, alias_name)
values ('idgi-alias', 'idgi-alias');

-- ---------------------------------------------------------------------------
-- 1. A grant whose org_id mismatches its identity's org is unrepresentable.

select throws_ok(
  $$insert into public.gateway_grants (org_id, identity_id, alias_id)
    values ('74000000-0000-0000-0000-000000000002', 'idgi-ident-a', 'idgi-alias')$$,
  '23503',
  null,
  'a grant naming another org''s identity fails the composite FK'
);

select lives_ok(
  $$insert into public.gateway_grants (org_id, identity_id, alias_id)
    values ('74000000-0000-0000-0000-000000000001', 'idgi-ident-a', 'idgi-alias')$$,
  'a grant whose org matches its identity''s org inserts'
);

-- ---------------------------------------------------------------------------
-- 2. The composite FK carries the identity-deletion cascade forward.

delete from public.gateway_identities where identity_id = 'idgi-ident-a';

select is(
  (select count(*)::int from public.gateway_grants
   where identity_id = 'idgi-ident-a'),
  0,
  'deleting the identity cascades its grants'
);

select is(
  (select count(*)::int from public.gateway_aliases
   where alias_id = 'idgi-alias'),
  1,
  'the granted alias itself is untouched by the cascade'
);

-- ---------------------------------------------------------------------------
-- 3. Constraint shape: the composite FK replaced the single-column FK (one
--    reference, one cascade — no double bookkeeping).

select ok(
  not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'gateway_grants_identity_id_fkey'
      and conrelid = 'public.gateway_grants'::regclass
  ),
  'the redundant single-column identity FK is gone'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'gateway_grants_org_identity_fkey'
      and conrelid = 'public.gateway_grants'::regclass
      and contype = 'f'
      and confdeltype = 'c'
  ),
  'the composite (org_id, identity_id) FK exists and cascades on delete'
);

select * from finish();

rollback;
