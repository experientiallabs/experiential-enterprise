begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- Fixture graph: one existing org with an admin, a member, and a viewer, plus
-- one platform admin who is not a member of that org.
insert into public.organizations (id, slug, name)
values ('70000000-0000-0000-0000-000000000001', 'rbac-org', 'RBAC Org');

insert into public.organization_members (org_id, user_id, role)
values
  ('70000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000091', 'admin'),
  ('70000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000092', 'user'),
  ('70000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000093', 'user');

insert into public.platform_admins (user_id)
values ('70000000-0000-0000-0000-000000000090');

-- Role helpers respect the membership role.
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000091', true);
select ok(
  public.is_org_admin('70000000-0000-0000-0000-000000000001'),
  'org admin passes is_org_admin'
);

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000092', true);
select ok(
  not public.is_org_admin('70000000-0000-0000-0000-000000000001'),
  'org member fails is_org_admin'
);

select ok(
  not public.is_platform_admin(),
  'ordinary member is not a platform admin'
);

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000090', true);
select ok(
  public.is_platform_admin(),
  'seeded platform admin passes is_platform_admin'
);

-- Platform admins create invitations directly under RLS.
set local role authenticated;

insert into public.org_invitations (email, token, org_name, invited_by)
values (
  'invitee@example.com',
  'rbac-test-invite-token',
  'invitee',
  '70000000-0000-0000-0000-000000000090'
);

select is(
  (select count(*)::int from public.org_invitations where email = 'invitee@example.com'),
  1,
  'platform admin inserts and reads an invitation'
);

reset role;

-- Non-admins can neither read nor create invitations.
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000092', true);
set local role authenticated;

select is(
  (select count(*)::int from public.org_invitations),
  0,
  'non-admins see no invitations'
);

select throws_ok(
  $$
  insert into public.org_invitations (email, org_name)
  values ('sneaky@example.com', 'Sneaky Org')
  $$,
  '42501',
  null,
  'non-admins cannot create invitations'
);

reset role;

-- platform_admins visibility: self row only for ordinary users.
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000092', true);
set local role authenticated;
select is(
  (select count(*)::int from public.platform_admins),
  0,
  'ordinary users see no platform_admins rows'
);
reset role;

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000090', true);
set local role authenticated;
select is(
  (select count(*)::int from public.platform_admins where user_id = '70000000-0000-0000-0000-000000000090'),
  1,
  'a platform admin sees their own row'
);
reset role;

-- Platform-admin grants are revocable by platform admins, and only by them.
insert into public.platform_admins (user_id)
values ('70000000-0000-0000-0000-000000000089');

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000092', true);
set local role authenticated;
delete from public.platform_admins where user_id = '70000000-0000-0000-0000-000000000089';
reset role;

select isnt_empty(
  $$ select 1 from public.platform_admins where user_id = '70000000-0000-0000-0000-000000000089' $$,
  'non-admin deletes of platform_admins rows are no-ops under RLS'
);

select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000090', true);
set local role authenticated;
delete from public.platform_admins where user_id = '70000000-0000-0000-0000-000000000089';
reset role;

select is_empty(
  $$ select 1 from public.platform_admins where user_id = '70000000-0000-0000-0000-000000000089' $$,
  'a platform admin revokes another admin''s grant'
);

-- Anonymous invite lookup resolves live tokens only, via the definer RPC.
select set_config('request.jwt.claim.sub', '', true);
set local role anon;

select is(
  (
    select lookup.org_name
    from public.lookup_org_invitation('rbac-test-invite-token') lookup
  ),
  'invitee',
  'anon resolves a live invite token to the org it will create'
);

select is_empty(
  $$ select * from public.lookup_org_invitation('not-a-token') $$,
  'anon lookup of an unknown token returns nothing'
);

select is(
  (select count(*)::int from public.org_invitations),
  0,
  'anon reads no invitation rows directly'
);

reset role;

-- Signup carrying the invite's token provisions the invited org.
-- The tenant name deliberately matches the email local part, reproducing the
-- personal-workspace backfill heuristic's closest collision.
insert into auth.users (id, email, raw_user_meta_data)
values (
  '70000000-0000-0000-0000-000000000010',
  'Invitee@Example.com',
  '{"invite_token": "rbac-test-invite-token"}'::jsonb
);

select isnt_empty(
  $$
  select 1
  from public.organizations orgs
  join public.organization_members members on members.org_id = orgs.id
  where members.user_id = '70000000-0000-0000-0000-000000000010'
    and members.role = 'admin'
    and orgs.name = 'invitee'
    and orgs.slug = 'invitee-70000000'
  $$,
  'invited signup owns a fresh org named by the invite'
);

select is_empty(
  $$
  select 1
  from public.account_workspaces
  where user_id = '70000000-0000-0000-0000-000000000010'
  $$,
  'a tenant-provisioning invite is not marked for account starter-world-model bootstrap'
);

-- Tenant orgs exist for the customer's own agent traces; the demo examples
-- are copied only into personal-fallback orgs.
select is(
  (
    select count(*)::int
    from public.world_models wm
    join public.organization_members members on members.org_id = wm.org_id
    where members.user_id = '70000000-0000-0000-0000-000000000010'
  ),
  0,
  'a provisioned tenant org receives no starter example copies'
);

select isnt_empty(
  $$
  select 1
  from public.org_invitations
  where email = 'invitee@example.com'
    and org_id is null
    and accepted_at is not null
    and accepted_by = '70000000-0000-0000-0000-000000000010'
  $$,
  'the invite is accepted by the signup'
);

-- A join invite adds membership in the existing org at the invited role.
insert into public.org_invitations (email, token, org_id, role)
values (
  'joiner@example.com',
  'rbac-join-token',
  '70000000-0000-0000-0000-000000000001',
  'user'
);

-- The lookup RPC carries org context for join invites (signup-page prefill).
select is(
  (
    select lookup.org_name || '/' || lookup.invited_role
    from public.lookup_org_invitation('rbac-join-token') lookup
  ),
  'RBAC Org/user',
  'join-invite lookup returns the organization name and invited role'
);

insert into auth.users (id, email, raw_user_meta_data)
values (
  '70000000-0000-0000-0000-000000000011',
  'joiner@example.com',
  '{"invite_token": "rbac-join-token"}'::jsonb
);

select is(
  (
    select members.role
    from public.organization_members members
    where members.user_id = '70000000-0000-0000-0000-000000000011'
      and members.org_id = '70000000-0000-0000-0000-000000000001'
  ),
  'user',
  'join invite lands the invitee in the existing org at the invited role'
);

-- An email-only signup (no token) for a still-pending invited address does
-- NOT consume the invite: the unverified email is not proof of ownership.
insert into public.org_invitations (email, token, org_id, role)
values (
  'emailonly@example.com',
  'rbac-email-only-token',
  '70000000-0000-0000-0000-000000000001',
  'user'
);

insert into auth.users (id, email)
values ('70000000-0000-0000-0000-000000000015', 'emailonly@example.com');

select is_empty(
  $$
  select 1
  from public.organization_members members
  where members.user_id = '70000000-0000-0000-0000-000000000015'
    and members.org_id = '70000000-0000-0000-0000-000000000001'
  $$,
  'email-only signup does not join the invited org without the token'
);

-- An invite-link token provisions even when the signup email differs from
-- the invited address.
insert into public.org_invitations (email, token, org_name)
values ('tenant2@example.com', 'rbac-tenant-token-2', 'Beta Corp');

insert into auth.users (id, email, raw_user_meta_data)
values (
  '70000000-0000-0000-0000-000000000013',
  'alias@example.com',
  '{"invite_token": "rbac-tenant-token-2"}'::jsonb
);

select isnt_empty(
  $$
  select 1
  from public.organizations orgs
  join public.organization_members members on members.org_id = orgs.id
  where members.user_id = '70000000-0000-0000-0000-000000000013'
    and members.role = 'admin'
    and orgs.name = 'Beta Corp'
    and orgs.slug = 'beta-corp-70000000'
  $$,
  'a token signup under a different email owns the provisioned tenant org'
);

select isnt_empty(
  $$
  select 1
  from public.org_invitations
  where token = 'rbac-tenant-token-2'
    and accepted_by = '70000000-0000-0000-0000-000000000013'
  $$,
  'the token invite is accepted by the aliased signup'
);

-- Uninvited signups keep the personal-org fallback.
insert into auth.users (id, email)
values ('70000000-0000-0000-0000-000000000012', 'walkin@example.com');

select is(
  (
    select count(*)::int
    from public.organization_members members
    where members.user_id = '70000000-0000-0000-0000-000000000012'
      and members.role = 'admin'
  ),
  1,
  'uninvited signup falls back to owning a personal org'
);

-- With the signups_enabled kill switch off, an uninvited signup receives no
-- tenancy at all.
update public.app_settings set signups_enabled = false;

insert into auth.users (id, email)
values ('70000000-0000-0000-0000-000000000014', 'gated@example.com');

select is(
  (
    select count(*)::int
    from public.organization_members members
    where members.user_id = '70000000-0000-0000-0000-000000000014'
  ),
  0,
  'uninvited signup while signups are disabled receives no membership'
);

select * from finish();

rollback;
