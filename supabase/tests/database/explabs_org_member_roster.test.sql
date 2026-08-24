begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

-- Fixture graph: two orgs; one member in each, plus an experiential admin
-- with no memberships. The RPC must scope reads to the caller's own org.
insert into public.platform_admins (user_id)
values ('81000000-0000-0000-0000-000000000090');

insert into public.organizations (id, slug, name)
values
  ('81000000-0000-0000-0000-000000000001', 'roster-a', 'Roster A'),
  ('81000000-0000-0000-0000-000000000002', 'roster-b', 'Roster B');

insert into auth.users (id, email)
values
  ('81000000-0000-0000-0000-000000000011', 'roster-a-admin@example.com'),
  ('81000000-0000-0000-0000-000000000012', 'roster-b-user@example.com');

insert into public.organization_members (org_id, user_id, role)
values
  ('81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000011', 'admin'),
  ('81000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-000000000012', 'user');

-- A member reads their own org's roster with emails.
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000011', true);
set local role authenticated;
select results_eq(
  $$ select email, role from public.org_members_with_emails('81000000-0000-0000-0000-000000000001') $$,
  $$ values ('roster-a-admin@example.com', 'admin') $$,
  'a member reads their own roster with emails'
);

-- A member cannot read another org's roster.
select throws_ok(
  $$ select * from public.org_members_with_emails('81000000-0000-0000-0000-000000000002') $$,
  'organization membership required',
  'a member cannot read a foreign roster'
);
reset role;

-- A user with no memberships reads nothing anywhere.
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000012', true);
set local role authenticated;
select throws_ok(
  $$ select * from public.org_members_with_emails('81000000-0000-0000-0000-000000000001') $$,
  'organization membership required',
  'an outsider cannot read a foreign roster'
);
reset role;

-- Experiential admins read any org's roster without membership rows.
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000090', true);
set local role authenticated;
select results_eq(
  $$ select email from public.org_members_with_emails('81000000-0000-0000-0000-000000000002') $$,
  $$ values ('roster-b-user@example.com') $$,
  'an experiential admin reads any roster'
);
reset role;

-- The two-rung role check holds at the table.
select throws_ok(
  $$ insert into public.organization_members (org_id, user_id, role)
     values ('81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000012', 'viewer') $$,
  '23514',
  null,
  'retired roles are unrepresentable'
);

select * from finish();
rollback;
