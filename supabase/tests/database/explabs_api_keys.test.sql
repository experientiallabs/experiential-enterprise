begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- Expiry set at mint time; NULL means the key never expires. Enforcement
-- happens in the backend's key resolution, not in RLS.
select has_column(
  'public',
  'api_keys',
  'expires_at',
  'api_keys carries an optional expiry'
);

-- Fixture: two orgs; one member of the first.
insert into public.organizations (id, slug, name)
values
  ('80000000-0000-0000-0000-000000000001', 'keys-org-a', 'Keys Org A'),
  ('80000000-0000-0000-0000-000000000002', 'keys-org-b', 'Keys Org B');

insert into public.organization_members (org_id, user_id, role)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000091', 'user');

insert into public.api_keys (org_id, name, key_prefix, key_hash)
values
  ('80000000-0000-0000-0000-000000000001', 'org-a key', 'xpl_aaaaaaaa', repeat('a', 64)),
  ('80000000-0000-0000-0000-000000000002', 'org-b key', 'xpl_bbbbbbbb', repeat('b', 64));

-- Members read only their org's keys.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000091', true);
set local role authenticated;

select is(
  (select count(*)::int from public.api_keys),
  1,
  'a member sees exactly their org''s keys'
);

select is(
  (select name from public.api_keys),
  'org-a key',
  'the visible key is the member org''s'
);

select throws_ok(
  $$
  insert into public.api_keys (org_id, name, key_prefix, key_hash)
  values ('80000000-0000-0000-0000-000000000001', 'sneaky', 'xpl_cccccccc', repeat('c', 64))
  $$,
  '42501',
  null,
  'members cannot insert keys directly (writes go through the admin API)'
);

reset role;

-- Non-members see nothing.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000099', true);
set local role authenticated;

select is(
  (select count(*)::int from public.api_keys),
  0,
  'non-members see no keys'
);

reset role;

-- The hash format is constrained.
select throws_ok(
  $$
  insert into public.api_keys (org_id, name, key_prefix, key_hash)
  values ('80000000-0000-0000-0000-000000000001', 'bad hash', 'xpl_dddddddd', 'not-a-hash')
  $$,
  '23514',
  null,
  'key_hash must be a sha256 hex digest'
);

select * from finish();

rollback;
