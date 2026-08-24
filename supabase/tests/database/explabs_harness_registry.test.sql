begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- Fixture: two orgs with a harness each; one member of the first.
insert into public.organizations (id, slug, name)
values
  ('90000000-0000-0000-0000-000000000001', 'harness-org-a', 'Harness Org A'),
  ('90000000-0000-0000-0000-000000000002', 'harness-org-b', 'Harness Org B');

insert into public.organization_members (org_id, user_id, role)
values ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000091', 'user');

insert into public.harnesses (id, org_id, name)
values
  ('90000000-0000-0000-0000-000000000021', '90000000-0000-0000-0000-000000000001', 'support-agent'),
  ('90000000-0000-0000-0000-000000000022', '90000000-0000-0000-0000-000000000002', 'foreign-agent');

insert into public.harness_versions (harness_id, version, doc, doc_hash)
values
  ('90000000-0000-0000-0000-000000000021', 1, '{"name": "support-agent"}', repeat('a', 32)),
  ('90000000-0000-0000-0000-000000000022', 1, '{"name": "foreign-agent"}', repeat('b', 32));

-- Members read only their org's harnesses and versions.
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000091', true);
set local role authenticated;

select is(
  (select count(*)::int from public.harnesses),
  1,
  'a member sees exactly their org''s harnesses'
);

select is(
  (select name from public.harnesses),
  'support-agent',
  'the visible harness is the member org''s'
);

select is(
  (select count(*)::int from public.harness_versions),
  1,
  'a member sees only versions of their org''s harnesses'
);

select throws_ok(
  $$
  insert into public.harnesses (org_id, name)
  values ('90000000-0000-0000-0000-000000000001', 'sneaky')
  $$,
  '42501',
  null,
  'members cannot insert harnesses directly'
);

select throws_ok(
  $$
  insert into public.harness_versions (harness_id, version, doc, doc_hash)
  values ('90000000-0000-0000-0000-000000000021', 2, '{}', repeat('c', 32))
  $$,
  '42501',
  null,
  'members cannot insert harness versions directly'
);

reset role;

select throws_ok(
  $$
  insert into public.harness_versions (harness_id, version, doc, doc_hash)
  values ('90000000-0000-0000-0000-000000000021', 2, '{}', 'not-a-hash')
  $$,
  '23514',
  null,
  'doc_hash must be 32 lowercase hex chars'
);

select * from finish();

rollback;
