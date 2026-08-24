begin;

create extension if not exists pgtap with schema extensions;

select plan(28);

-- Admin org bans (migration 20260829160000_admin_org_bans): banning a tenant
-- is ONE transaction (public.record_org_ban) that sets organizations.banned_at,
-- records who/when/why in public.org_bans, revokes EVERY live key of the org
-- (org_id-scoped, unlike a user ban's created_by scoping), revokes pending
-- invites, and sweeps every current member through record_user_ban — except
-- platform operators and members already banned individually. Unban
-- (public.clear_org_ban) restores exactly the swept members (unless another
-- banned org adopts them), clears banned_at, and leaves keys and invites
-- revoked. admin_list_org_bans is the panel roster and is platform-admin gated.

-- Signups off so bare auth.users inserts do not auto-provision; this suite
-- seeds fixed-UUID orgs/memberships/keys itself.
update public.app_settings set signups_enabled = false;

-- ---------------------------------------------------------------------------
-- Fixtures: operator a1 is a platform admin AND a member of the org to be
-- banned (proving the operator exemption). Org 1 is the ban target with
-- members m2 (with a key in org 1, a personal key in org 2, and a session),
-- m3 (individually pre-banned), and m4 (also a member of org 3, exercising
-- the adoption path). Org 2 is a bystander tenant; b5 is its own member.

insert into auth.users (id, email, email_confirmed_at) values
  ('82000000-0000-0000-0000-0000000000a1', 'orgban-operator@pgtap.example', now()),
  ('82000000-0000-0000-0000-0000000000a2', 'orgban-member@pgtap.example', now()),
  ('82000000-0000-0000-0000-0000000000a3', 'orgban-prebanned@pgtap.example', now()),
  ('82000000-0000-0000-0000-0000000000a4', 'orgban-multiorg@pgtap.example', now()),
  ('82000000-0000-0000-0000-0000000000a5', 'orgban-bystander@pgtap.example', now());
insert into public.platform_admins (user_id) values
  ('82000000-0000-0000-0000-0000000000a1');

insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('82000000-0000-0000-0000-000000000001', 'pgtap-orgban-one', 'pgTAP OrgBan One', now()),
  ('82000000-0000-0000-0000-000000000002', 'pgtap-orgban-two', 'pgTAP OrgBan Two', now()),
  ('82000000-0000-0000-0000-000000000003', 'pgtap-orgban-three', 'pgTAP OrgBan Three', now());
insert into public.organization_members (org_id, user_id, role) values
  ('82000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-0000000000a1', 'admin'),
  ('82000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-0000000000a2', 'admin'),
  ('82000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-0000000000a3', 'user'),
  ('82000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-0000000000a4', 'user'),
  ('82000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-0000000000a2', 'admin'),
  ('82000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-0000000000a5', 'admin'),
  ('82000000-0000-0000-0000-000000000003', '82000000-0000-0000-0000-0000000000a4', 'admin');

-- Keys: two live keys in org 1 (m2's and the operator's), m2's personal key
-- in bystander org 2, and b5's own org-2 key.
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('82000000-0000-0000-0000-0000000000b1', '82000000-0000-0000-0000-000000000001',
   'member key org one', 'xpl_ob1', encode(sha256('ob-k1'::bytea), 'hex'),
   '82000000-0000-0000-0000-0000000000a2'),
  ('82000000-0000-0000-0000-0000000000b2', '82000000-0000-0000-0000-000000000001',
   'operator key org one', 'xpl_ob2', encode(sha256('ob-k2'::bytea), 'hex'),
   '82000000-0000-0000-0000-0000000000a1'),
  ('82000000-0000-0000-0000-0000000000b3', '82000000-0000-0000-0000-000000000002',
   'member personal key org two', 'xpl_ob3', encode(sha256('ob-k3'::bytea), 'hex'),
   '82000000-0000-0000-0000-0000000000a2'),
  ('82000000-0000-0000-0000-0000000000b4', '82000000-0000-0000-0000-000000000002',
   'bystander key org two', 'xpl_ob4', encode(sha256('ob-k4'::bytea), 'hex'),
   '82000000-0000-0000-0000-0000000000a5');

insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('82000000-0000-0000-0000-0000000000d1', '82000000-0000-0000-0000-0000000000a2', now(), now()),
  ('82000000-0000-0000-0000-0000000000d2', '82000000-0000-0000-0000-0000000000a1', now(), now()),
  ('82000000-0000-0000-0000-0000000000d3', '82000000-0000-0000-0000-0000000000a5', now(), now());

-- Pending invites: one in the banned org (must be revoked by the ban), one in
-- the bystander org (must survive).
insert into public.org_invitations (id, org_id, email, role) values
  ('82000000-0000-0000-0000-0000000000e1', '82000000-0000-0000-0000-000000000001',
   'orgban-invitee@pgtap.example', 'user'),
  ('82000000-0000-0000-0000-0000000000e2', '82000000-0000-0000-0000-000000000002',
   'orgban-invitee@pgtap.example', 'user');

-- m3 carries an individual ban BEFORE the org ban; its provenance must survive.
select public.record_user_ban(
  '82000000-0000-0000-0000-0000000000a3',
  '82000000-0000-0000-0000-0000000000a1',
  'Individually banned before the org'
);

-- ---------------------------------------------------------------------------
-- Banning the org: record, enforcement column, keys, invites, member sweep.

select public.record_org_ban(
  '82000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-0000000000a1',
  'Coordinated abuse of promotional credits'
);

select is(
  (select reason from public.org_bans
    where org_id = '82000000-0000-0000-0000-000000000001'),
  'Coordinated abuse of promotional credits',
  'the org ban record carries the reason'
);

select is(
  (select banned_by from public.org_bans
    where org_id = '82000000-0000-0000-0000-000000000001'),
  '82000000-0000-0000-0000-0000000000a1'::uuid,
  'the org ban record carries who banned'
);

select isnt(
  (select banned_at from public.organizations
    where id = '82000000-0000-0000-0000-000000000001'),
  null::timestamptz,
  'banning sets organizations.banned_at in the same transaction'
);

select is(
  (select count(*)::int from public.api_keys
    where org_id = '82000000-0000-0000-0000-000000000001' and revoked_at is null),
  0,
  'every live key of the banned org is revoked, whoever minted it'
);

select isnt(
  (select revoked_at from public.api_keys
    where id = '82000000-0000-0000-0000-0000000000b3'),
  null::timestamptz,
  'the swept member''s personal key in ANOTHER org is revoked too (record_user_ban semantics)'
);

select is(
  (select revoked_at from public.api_keys
    where id = '82000000-0000-0000-0000-0000000000b4'),
  null::timestamptz,
  'the bystander org''s own key is NOT revoked'
);

select isnt(
  (select revoked_at from public.org_invitations
    where id = '82000000-0000-0000-0000-0000000000e1'),
  null::timestamptz,
  'the banned org''s pending invite is revoked'
);

select is(
  (select revoked_at from public.org_invitations
    where id = '82000000-0000-0000-0000-0000000000e2'),
  null::timestamptz,
  'the bystander org''s pending invite survives'
);

select isnt(
  (select banned_until from auth.users where id = '82000000-0000-0000-0000-0000000000a2'),
  null::timestamptz,
  'a current member is GoTrue-banned by the sweep'
);

select is(
  (select banned_via_org_id from public.user_bans
    where user_id = '82000000-0000-0000-0000-0000000000a2'),
  '82000000-0000-0000-0000-000000000001'::uuid,
  'the swept member''s ban records which org ban owns it'
);

select is(
  (select count(*)::int from auth.sessions
    where user_id = '82000000-0000-0000-0000-0000000000a2'),
  0,
  'the swept member''s sessions are severed'
);

select is(
  (select banned_until from auth.users where id = '82000000-0000-0000-0000-0000000000a1'),
  null::timestamptz,
  'the platform operator member is NOT swept'
);

select is(
  (select count(*)::int from auth.sessions
    where id = '82000000-0000-0000-0000-0000000000d2'),
  1,
  'the platform operator''s session survives'
);

select is(
  (select reason from public.user_bans
    where user_id = '82000000-0000-0000-0000-0000000000a3'),
  'Individually banned before the org',
  'a member already banned individually keeps that ban''s provenance'
);

select is(
  (select banned_via_org_id from public.user_bans
    where user_id = '82000000-0000-0000-0000-0000000000a3'),
  null::uuid,
  'the pre-existing individual ban is not claimed by the org ban'
);

select is(
  (select banned_until from auth.users where id = '82000000-0000-0000-0000-0000000000a5'),
  null::timestamptz,
  'members of other orgs are untouched'
);

-- ---------------------------------------------------------------------------
-- admin_list_org_bans: platform-admin gated roster with the banner's email.

select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;

select is(
  (select banned_by_email from public.admin_list_org_bans()
    where org_id = '82000000-0000-0000-0000-000000000001'),
  'orgban-operator@pgtap.example',
  'admin_list_org_bans resolves who banned to an email'
);

select is(
  (select count(*)::int from public.org_bans),
  1,
  'a platform admin reads the org ban roster under their own RLS session'
);

select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000000a5', true);

select throws_ok(
  $$ select * from public.admin_list_org_bans() $$,
  'P0001',
  'platform admin required',
  'admin_list_org_bans refuses non-admins'
);

select is(
  (select count(*)::int from public.org_bans),
  0,
  'RLS hides org ban records from non-admins'
);

reset role;

-- ---------------------------------------------------------------------------
-- Adoption: banning org 3 while m4 is already banned via org 1 leaves m4's
-- provenance with org 1; unbanning org 1 must then hand m4 to org 3 instead
-- of freeing a member of a still-banned tenant.

select public.record_org_ban(
  '82000000-0000-0000-0000-000000000003',
  '82000000-0000-0000-0000-0000000000a1',
  'Same abuse ring'
);

select is(
  (select banned_via_org_id from public.user_bans
    where user_id = '82000000-0000-0000-0000-0000000000a4'),
  '82000000-0000-0000-0000-000000000001'::uuid,
  'a member already swept by another org ban is not re-swept'
);

-- ---------------------------------------------------------------------------
-- Unban: enforcement and record clear together, swept members are restored,
-- individual bans and revoked credentials stay.

select public.clear_org_ban('82000000-0000-0000-0000-000000000001');

select is(
  (select banned_at from public.organizations
    where id = '82000000-0000-0000-0000-000000000001'),
  null::timestamptz,
  'unban clears organizations.banned_at'
);

select is(
  (select count(*)::int from public.org_bans
    where org_id = '82000000-0000-0000-0000-000000000001'),
  0,
  'unban removes the org ban record'
);

select is(
  (select banned_until from auth.users where id = '82000000-0000-0000-0000-0000000000a2'),
  null::timestamptz,
  'unban restores sign-in for the members this ban swept'
);

select is(
  (select banned_via_org_id from public.user_bans
    where user_id = '82000000-0000-0000-0000-0000000000a4'),
  '82000000-0000-0000-0000-000000000003'::uuid,
  'a swept member still in another banned org is adopted, not freed'
);

select isnt(
  (select banned_until from auth.users where id = '82000000-0000-0000-0000-0000000000a3'),
  null::timestamptz,
  'a member banned individually before the org ban STAYS banned after unban'
);

select is(
  (select count(*)::int from public.api_keys
    where org_id = '82000000-0000-0000-0000-000000000001' and revoked_at is null),
  0,
  'keys revoked at ban time stay revoked after unban'
);

select lives_ok(
  $$ select public.clear_org_ban('82000000-0000-0000-0000-000000000001') $$,
  'unbanning an org that is not banned is a no-op'
);

select * from finish();

rollback;
