begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- Fixture graph: a platform admin, two orgs, a member of org A with an auth
-- account, and a second auth account with no memberships.
insert into public.platform_admins (user_id)
values ('80000000-0000-0000-0000-000000000090');

insert into public.organizations (id, slug, name)
values
  ('80000000-0000-0000-0000-000000000001', 'org-admin-a', 'Org Admin A'),
  ('80000000-0000-0000-0000-000000000002', 'org-admin-b', 'Org Admin B');

insert into auth.users (id, email)
values
  ('80000000-0000-0000-0000-000000000011', 'member-a@example.com'),
  ('80000000-0000-0000-0000-000000000012', 'floater@example.com');

-- The signup trigger provisioned personal orgs for those inserts; pin the
-- membership this suite exercises explicitly.
insert into public.organization_members (org_id, user_id, role)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011', 'user');

-- The write grants themselves: the throwaway test container replays the
-- migration chain, so this fails when the grant migration is missing - the
-- policies alone are unreachable without it (2026-08-01).
select ok(
  has_table_privilege('authenticated', 'public.organizations', 'INSERT'),
  'authenticated holds the INSERT grant the platform-admin policy gates'
);

-- Platform admins create organizations under RLS.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000090', true);
set local role authenticated;
insert into public.organizations (slug, name)
values ('org-admin-created', 'Created By Admin');
select isnt_empty(
  $$ select 1 from public.organizations where slug = 'org-admin-created' $$,
  'platform admin creates an organization'
);
reset role;

-- Non-admins cannot.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000011', true);
set local role authenticated;
select throws_ok(
  $$ insert into public.organizations (slug, name) values ('sneaky-org', 'Sneaky') $$,
  '42501',
  null,
  'non-admins cannot create organizations'
);
reset role;

-- Reassignment: one UPDATE moves the membership between orgs and changes role.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000090', true);
set local role authenticated;
update public.organization_members
set org_id = '80000000-0000-0000-0000-000000000002', role = 'admin'
where org_id = '80000000-0000-0000-0000-000000000001'
  and user_id = '80000000-0000-0000-0000-000000000011';
reset role;

select is(
  (
    select members.org_id::text || '/' || members.role
    from public.organization_members members
    where members.user_id = '80000000-0000-0000-0000-000000000011'
      and members.org_id in (
        '80000000-0000-0000-0000-000000000001',
        '80000000-0000-0000-0000-000000000002'
      )
  ),
  '80000000-0000-0000-0000-000000000002/admin',
  'platform admin moves a membership to another org with a new role'
);

-- Non-admin updates are silent no-ops under RLS.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000011', true);
set local role authenticated;
update public.organization_members
set role = 'user'
where user_id = '80000000-0000-0000-0000-000000000011';
reset role;

select is(
  (
    select members.role from public.organization_members members
    where members.user_id = '80000000-0000-0000-0000-000000000011'
      and members.org_id = '80000000-0000-0000-0000-000000000002'
  ),
  'admin',
  'non-admins cannot change memberships'
);

-- Deleting an org removes its memberships by cascade.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000090', true);
set local role authenticated;
delete from public.organizations where id = '80000000-0000-0000-0000-000000000002';
reset role;

select is_empty(
  $$
  select 1 from public.organization_members
  where org_id = '80000000-0000-0000-0000-000000000002'
  $$,
  'deleting an organization cascades its memberships'
);

-- invitee_account_state: none / member / user, gated on admin callers.
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000090', true);
set local role authenticated;
select is(
  public.invitee_account_state('80000000-0000-0000-0000-000000000001', 'nobody@example.com'),
  'none',
  'unknown emails report none'
);
-- member-a now lives in their personal org (signup trigger) after the org B
-- delete; check member state against that org via the floater fixture.
insert into public.organization_members (org_id, user_id, role)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000012', 'user');
-- Account STATES are their own vocabulary: 'member' = already in the org,
-- 'user' = account exists elsewhere. Distinct from the role ladder.
select is(
  public.invitee_account_state('80000000-0000-0000-0000-000000000001', 'Floater@Example.com'),
  'member',
  'org members report member (case-insensitive)'
);
select is(
  public.invitee_account_state(null, 'member-a@example.com'),
  'user',
  'accounts outside the org report user'
);
reset role;

select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000011', true);
set local role authenticated;
select throws_ok(
  $$ select public.invitee_account_state('80000000-0000-0000-0000-000000000001', 'nobody@example.com') $$,
  'organization admin required',
  'non-admin callers cannot probe account state'
);
select throws_ok(
  $$ select * from public.admin_list_org_members() $$,
  'platform admin required',
  'non-admins cannot list the member roster'
);
reset role;

select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000090', true);
set local role authenticated;
select isnt_empty(
  $$
  select 1 from public.admin_list_org_members()
  where email = 'floater@example.com' and role = 'user'
  $$,
  'platform admins list members with their auth emails'
);

-- Email -> account id lookup for the add-member action.
select is(
  public.admin_user_id_for_email('Member-A@Example.com'),
  '80000000-0000-0000-0000-000000000011'::uuid,
  'platform admins resolve an account id by email (case-insensitive)'
);
reset role;

select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000011', true);
set local role authenticated;
select throws_ok(
  $$ select public.admin_user_id_for_email('member-a@example.com') $$,
  'platform admin required',
  'non-admins cannot resolve account ids by email'
);
reset role;

select * from finish();

rollback;
