begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

-- The gate ships enabled for the initial rollout; it is hot-toggled off in
-- the database once the first accounts exist.
select is(
  (select signups_enabled from public.app_settings),
  true,
  'signups are enabled by default'
);

-- Everything below exercises the invite-only mode.
update public.app_settings set signups_enabled = false;

-- An uninvited signup while signups are disabled gets no membership: the
-- auth user lands (GoTrue owns that insert) but no tenancy is provisioned.
insert into auth.users (id, email)
values ('50000000-0000-0000-0000-000000000001', 'uninvited@example.com');

select is_empty(
  $$
  select 1
  from public.organization_members
  where user_id = '50000000-0000-0000-0000-000000000001'
  $$,
  'uninvited signup while disabled provisions no membership'
);

-- Invited signups are provisioned regardless of the kill switch, but ONLY
-- when the signup carries the invite's secret token. The token is the sole
-- proof of inbox ownership; an unverified signup email must not consume an
-- invite (email confirmation is disabled).
insert into public.organizations (id, slug, name)
values ('50000000-0000-0000-0000-00000000aaaa', 'invite-test-org', 'Invite Test Org');

insert into public.org_invitations (id, org_id, email, role, token)
values (
  '50000000-0000-0000-0000-00000000bbbb',
  '50000000-0000-0000-0000-00000000aaaa',
  'Invited.Person@Example.com',
  'admin',
  'invite-token-admin'
);

-- Knowing the invited email is not enough: a signup for that address with no
-- token consumes nothing and provisions no membership.
insert into auth.users (id, email)
values ('50000000-0000-0000-0000-00000000000a', 'invited.person@example.com');

select is_empty(
  $$
  select 1
  from public.organization_members
  where user_id = '50000000-0000-0000-0000-00000000000a'
  $$,
  'email-only signup (no token) provisions no membership'
);

select isnt_empty(
  $$
  select 1
  from public.org_invitations
  where id = '50000000-0000-0000-0000-00000000bbbb'
    and accepted_at is null
  $$,
  'email-only signup leaves the invite unconsumed'
);

-- GoTrue keeps auth emails unique, so the token-less account must go away
-- before the invited signup for the same address can exist. Deleting it fires
-- the auth-user cleanup trigger, which also removes the address's pending
-- invite history; recreate the invite the link signup will consume.
delete from auth.users where id = '50000000-0000-0000-0000-00000000000a';

insert into public.org_invitations (id, org_id, email, role, token)
values (
  '50000000-0000-0000-0000-00000000bbbb',
  '50000000-0000-0000-0000-00000000aaaa',
  'Invited.Person@Example.com',
  'admin',
  'invite-token-admin'
);

-- Following the invite link carries the token; matching consumes the invite.
insert into auth.users (id, email, raw_user_meta_data)
values (
  '50000000-0000-0000-0000-000000000002',
  'invited.person@example.com',
  '{"invite_token": "invite-token-admin"}'::jsonb
);

select is(
  (
    select role
    from public.organization_members
    where user_id = '50000000-0000-0000-0000-000000000002'
      and org_id = '50000000-0000-0000-0000-00000000aaaa'
  ),
  'admin',
  'token-bearing signup joins the inviting org with the invited role'
);

select is(
  (
    select count(*)::int
    from public.organization_members
    where user_id = '50000000-0000-0000-0000-000000000002'
  ),
  1,
  'invited signup gets no personal org alongside the invited membership'
);

select is_empty(
  $$
  select 1
  from public.account_workspaces
  where user_id = '50000000-0000-0000-0000-000000000002'
  $$,
  'joining an existing workspace does not provision an account starter world model'
);

select isnt_empty(
  $$
  select 1
  from public.org_invitations
  where id = '50000000-0000-0000-0000-00000000bbbb'
    and accepted_at is not null
    and accepted_by = '50000000-0000-0000-0000-000000000002'
  $$,
  'consumed invite records acceptance time and accepting user'
);

-- Expired invites are ignored even when the signup carries their token.
insert into public.org_invitations (org_id, email, role, token, expires_at)
values (
  '50000000-0000-0000-0000-00000000aaaa',
  'late@example.com',
  'user',
  'invite-token-late',
  now() - interval '1 day'
);

insert into auth.users (id, email, raw_user_meta_data)
values (
  '50000000-0000-0000-0000-000000000003',
  'late@example.com',
  '{"invite_token": "invite-token-late"}'::jsonb
);

select is_empty(
  $$
  select 1
  from public.organization_members
  where user_id = '50000000-0000-0000-0000-000000000003'
  $$,
  'expired invite provisions nothing while signups are disabled'
);

-- A token consumes only its own invite. A user invited to several orgs
-- carries one link's token per signup, so only that invite is claimed; the
-- others stay pending until their own links are followed.
insert into public.organizations (id, slug, name)
values ('50000000-0000-0000-0000-00000000cccc', 'second-invite-org', 'Second Invite Org');

insert into public.org_invitations (org_id, email, role, token)
values
  ('50000000-0000-0000-0000-00000000aaaa', 'multi@example.com', 'user', 'invite-token-multi-a'),
  ('50000000-0000-0000-0000-00000000cccc', 'multi@example.com', 'user', 'invite-token-multi-c');

insert into auth.users (id, email, raw_user_meta_data)
values (
  '50000000-0000-0000-0000-000000000004',
  'multi@example.com',
  '{"invite_token": "invite-token-multi-a"}'::jsonb
);

select is(
  (
    select org_id
    from public.organization_members
    where user_id = '50000000-0000-0000-0000-000000000004'
  ),
  '50000000-0000-0000-0000-00000000aaaa'::uuid,
  'the token-matched invite is the only one applied on signup'
);

select isnt_empty(
  $$
  select 1
  from public.org_invitations
  where token = 'invite-token-multi-c'
    and accepted_at is null
  $$,
  'invites whose token was not presented stay pending'
);

-- Only one pending invite per (org, email); history rows do not collide.
select throws_ok(
  $$
  insert into public.org_invitations (org_id, email)
  values ('50000000-0000-0000-0000-00000000aaaa', 'LATE@example.com')
  $$,
  '23505',
  null,
  'a second pending invite for the same org and email is rejected'
);

select lives_ok(
  $$
  insert into public.org_invitations (org_id, email)
  values ('50000000-0000-0000-0000-00000000aaaa', 'invited.person@example.com')
  $$,
  'a new pending invite is allowed once the previous one was accepted'
);

-- Revoked invites are history too: they stop holding the pending slot the
-- moment they are revoked, even before they expire.
update public.org_invitations
set revoked_at = now()
where token = 'invite-token-multi-c';

select lives_ok(
  $$
  insert into public.org_invitations (org_id, email)
  values ('50000000-0000-0000-0000-00000000cccc', 'multi@example.com')
  $$,
  'a new pending invite is allowed once the previous one was revoked'
);

-- With signups enabled, the personal-org fallback opens back up.
update public.app_settings set signups_enabled = true;

insert into auth.users (id, email)
values ('50000000-0000-0000-0000-000000000005', 'open@example.com');

select isnt_empty(
  $$
  select 1
  from public.organizations orgs
  join public.organization_members members on members.org_id = orgs.id
  where members.user_id = '50000000-0000-0000-0000-000000000005'
    and members.role = 'admin'
    and orgs.slug = 'open-50000000'
  $$,
  'enabling signups restores personal-org provisioning'
);

select * from finish();

rollback;
