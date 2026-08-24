begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

-- gw-identity P-B companion: the BEFORE INSERT trigger on api_keys assigns the
-- org's default identity when a key is created without one (POST /api/keys,
-- /api/activate), get-or-creating the identity row so no created key is left
-- with a null identity under deny-by-default.

-- The new-org trigger (20260820095000) seeds each org's default identity on
-- insert, so a real org normally HAS its identity before any key is created. To
-- exercise both branches of the api_keys trigger honestly: org A drops its
-- trigger-seeded identity (the defensive get-or-create branch — a key for an org
-- whose identity row is somehow absent), and org B keeps it (the normal assign
-- branch).
insert into public.organizations (id, slug, name) values
  ('88000000-0000-0000-0000-000000000001', 'apikey-id-a', 'API Key Identity A'),
  ('88000000-0000-0000-0000-000000000002', 'apikey-id-b', 'API Key Identity B');
-- Force the get-or-create branch for org A: remove the identity the new-org
-- trigger just seeded (grants cascade with it).
delete from public.gateway_identities
  where identity_id = 'org-88000000-0000-0000-0000-000000000001';

-- 1. GET-OR-CREATE branch: a key for an org with no identity row is assigned a
--    default identity that the trigger creates on the fly.
insert into public.api_keys (id, org_id, name, key_prefix, key_hash)
  values ('88000000-0000-0000-0000-0000000000a1',
          '88000000-0000-0000-0000-000000000001', 'k-a', 'xpl_a',
          encode(sha256('a'::bytea), 'hex'));
select is(
  (select identity_id from public.api_keys
     where id = '88000000-0000-0000-0000-0000000000a1'),
  'org-88000000-0000-0000-0000-000000000001',
  'a key for an org with no identity row is assigned a get-or-created default identity'
);
select is(
  (select count(*)::int from public.gateway_identities
     where identity_id = 'org-88000000-0000-0000-0000-000000000001'),
  1,
  'the api_keys trigger get-or-creates the missing default identity'
);

-- 2. ASSIGN branch: org B kept its trigger-seeded identity; the key is assigned
--    it with no duplicate row.
insert into public.api_keys (id, org_id, name, key_prefix, key_hash)
  values ('88000000-0000-0000-0000-0000000000b1',
          '88000000-0000-0000-0000-000000000002', 'k-b', 'xpl_b',
          encode(sha256('b'::bytea), 'hex'));
select is(
  (select identity_id from public.api_keys
     where id = '88000000-0000-0000-0000-0000000000b1'),
  'org-88000000-0000-0000-0000-000000000002',
  'a key for an org with an existing default identity is assigned it'
);
select is(
  (select count(*)::int from public.gateway_identities
     where org_id = '88000000-0000-0000-0000-000000000002'),
  1,
  'no duplicate identity row is created when one already exists'
);

select * from finish();

rollback;
