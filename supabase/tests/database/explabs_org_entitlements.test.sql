begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- Per-org enterprise entitlements: capability vocabulary pinned, org-delete
-- cascade, and the browser-role deny posture. Ids prefixed '86...'.

insert into public.organizations (id, slug, name) values
  ('86000000-0000-0000-0000-000000000001', 'ent-org-a', 'Entitlements Org A');

select lives_ok(
  $$insert into public.org_entitlements (org_id, capability, granted_by)
    values ('86000000-0000-0000-0000-000000000001', 'sso',
            '86000000-0000-0000-0000-0000000000aa')$$,
  'a pinned capability key inserts'
);

select throws_ok(
  $$insert into public.org_entitlements (org_id, capability)
    values ('86000000-0000-0000-0000-000000000001', 'made_up')$$,
  '23514',
  null,
  'an unknown capability key is refused'
);

select throws_ok(
  $$insert into public.org_entitlements (org_id, capability)
    values ('86000000-0000-0000-0000-000000000001', 'sso')$$,
  '23505',
  null,
  'one row per (org, capability)'
);

set local role authenticated;

select throws_ok(
  $$select count(*) from public.org_entitlements$$,
  '42501',
  null,
  'authenticated cannot read entitlements'
);

select throws_ok(
  $$insert into public.org_entitlements (org_id, capability)
    values ('86000000-0000-0000-0000-000000000001', 'teams')$$,
  '42501',
  null,
  'authenticated cannot grant entitlements'
);

reset role;

delete from public.organizations where id = '86000000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.org_entitlements
    where org_id = '86000000-0000-0000-0000-000000000001'),
  0::bigint,
  'entitlements cascade with the org'
);

select * from finish();

rollback;
