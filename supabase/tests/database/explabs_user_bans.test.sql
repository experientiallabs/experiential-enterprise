begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- Admin user bans (migration 20260829120000_admin_user_bans): banning is ONE
-- transaction (public.record_user_ban) that sets GoTrue's banned_until,
-- records who/when/why in public.user_bans, revokes every API key the banned
-- user MINTED — created_by scoping, cross-org, exactly the personal-keys
-- predicate of 20260823010000 — and deletes every GoTrue session of that
-- user. Other members' keys and sessions are untouched even inside the
-- banned user's orgs. Unban (public.clear_user_ban) atomically clears
-- banned_until and the record; keys stay revoked (revocation is one-way).
-- admin_list_users is the panel roster and is platform-admin gated.

-- Signups off so bare auth.users inserts do not auto-provision; this suite
-- seeds fixed-UUID orgs/memberships/keys itself.
update public.app_settings set signups_enabled = false;

-- ---------------------------------------------------------------------------
-- Fixtures: an operator, a ban target with keys in TWO orgs and two sessions,
-- and a bystander member sharing org 1 with a key and session of their own.

insert into auth.users (id, email, email_confirmed_at) values
  ('81000000-0000-0000-0000-0000000000a1', 'ban-operator@pgtap.example', now()),
  ('81000000-0000-0000-0000-0000000000a2', 'ban-target@pgtap.example', now()),
  ('81000000-0000-0000-0000-0000000000a3', 'ban-bystander@pgtap.example', now());
insert into public.platform_admins (user_id) values
  ('81000000-0000-0000-0000-0000000000a1');

insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('81000000-0000-0000-0000-000000000001', 'pgtap-ban-one', 'pgTAP Ban One', now()),
  ('81000000-0000-0000-0000-000000000002', 'pgtap-ban-two', 'pgTAP Ban Two', now());
insert into public.organization_members (org_id, user_id, role) values
  ('81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-0000000000a2', 'admin'),
  ('81000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-0000000000a3', 'user'),
  ('81000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-0000000000a2', 'admin');

-- The target's keys in both orgs, and the bystander's key in the shared org.
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('81000000-0000-0000-0000-0000000000b1', '81000000-0000-0000-0000-000000000001',
   'target key org one', 'xpl_ban1', encode(sha256('ban-k1'::bytea), 'hex'),
   '81000000-0000-0000-0000-0000000000a2'),
  ('81000000-0000-0000-0000-0000000000b2', '81000000-0000-0000-0000-000000000002',
   'target key org two', 'xpl_ban2', encode(sha256('ban-k2'::bytea), 'hex'),
   '81000000-0000-0000-0000-0000000000a2'),
  ('81000000-0000-0000-0000-0000000000b3', '81000000-0000-0000-0000-000000000001',
   'bystander key', 'xpl_ban3', encode(sha256('ban-k3'::bytea), 'hex'),
   '81000000-0000-0000-0000-0000000000a3');

-- The target holds a superadmin key (they were once an operator) and the
-- operator holds their own; a ban must kill the target's and spare the
-- operator's (20260829160000_ban_revokes_superadmin_keys).
insert into public.platform_admin_keys (id, user_id, owner_email, name, key_prefix, key_hash) values
  ('81000000-0000-0000-0000-0000000000c1', '81000000-0000-0000-0000-0000000000a2',
   'ban-target@pgtap.example', 'target superadmin key', 'xpladmin_ban1',
   encode(sha256('ban-sk1'::bytea), 'hex')),
  ('81000000-0000-0000-0000-0000000000c2', '81000000-0000-0000-0000-0000000000a1',
   'ban-operator@pgtap.example', 'operator superadmin key', 'xpladmin_ban2',
   encode(sha256('ban-sk2'::bytea), 'hex'));

insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('81000000-0000-0000-0000-0000000000d1', '81000000-0000-0000-0000-0000000000a2', now(), now()),
  ('81000000-0000-0000-0000-0000000000d2', '81000000-0000-0000-0000-0000000000a2', now(), now()),
  ('81000000-0000-0000-0000-0000000000d3', '81000000-0000-0000-0000-0000000000a3', now(), now());

-- ---------------------------------------------------------------------------
-- Banning records provenance and tears down the target's credentials only.

select public.record_user_ban(
  '81000000-0000-0000-0000-0000000000a2',
  '81000000-0000-0000-0000-0000000000a1',
  'Fraudulent gateway usage'
);

select is(
  (select reason from public.user_bans
    where user_id = '81000000-0000-0000-0000-0000000000a2'),
  'Fraudulent gateway usage',
  'the ban record carries the reason'
);

select is(
  (select banned_by from public.user_bans
    where user_id = '81000000-0000-0000-0000-0000000000a2'),
  '81000000-0000-0000-0000-0000000000a1'::uuid,
  'the ban record carries who banned'
);

select isnt(
  (select banned_until from auth.users where id = '81000000-0000-0000-0000-0000000000a2'),
  null::timestamptz,
  'banning sets GoTrue banned_until in the same transaction'
);

select is(
  (select banned_until from auth.users where id = '81000000-0000-0000-0000-0000000000a3'),
  null::timestamptz,
  'the bystander is not GoTrue-banned'
);

select isnt(
  (select revoked_at from public.api_keys where id = '81000000-0000-0000-0000-0000000000b1'),
  null::timestamptz,
  'the banned user''s key in org one is revoked'
);

select isnt(
  (select revoked_at from public.api_keys where id = '81000000-0000-0000-0000-0000000000b2'),
  null::timestamptz,
  'the banned user''s key in their OTHER org is revoked too (created_by, cross-org)'
);

select is(
  (select revoked_at from public.api_keys where id = '81000000-0000-0000-0000-0000000000b3'),
  null::timestamptz,
  'the bystander''s key in the shared org is NOT revoked'
);

select isnt(
  (select revoked_at from public.platform_admin_keys
    where id = '81000000-0000-0000-0000-0000000000c1'),
  null::timestamptz,
  'the banned user''s SUPERADMIN key is revoked in the same transaction'
);

select is(
  (select revoked_at from public.platform_admin_keys
    where id = '81000000-0000-0000-0000-0000000000c2'),
  null::timestamptz,
  'the operator''s own superadmin key is untouched'
);

select is(
  (select count(*)::int from auth.sessions
    where user_id = '81000000-0000-0000-0000-0000000000a2'),
  0,
  'every session of the banned user is deleted'
);

select is(
  (select count(*)::int from auth.sessions
    where id = '81000000-0000-0000-0000-0000000000d3'),
  1,
  'the bystander''s session survives'
);

-- Re-banning is an idempotent upsert that refreshes the provenance.
select public.record_user_ban(
  '81000000-0000-0000-0000-0000000000a2',
  '81000000-0000-0000-0000-0000000000a1',
  'Chargeback abuse'
);

select is(
  (select count(*)::int from public.user_bans
    where user_id = '81000000-0000-0000-0000-0000000000a2'),
  1,
  're-banning keeps a single record per user'
);

select is(
  (select reason from public.user_bans
    where user_id = '81000000-0000-0000-0000-0000000000a2'),
  'Chargeback abuse',
  're-banning updates the reason'
);

-- The reason is required: blank rejects at the table constraint.
select throws_ok(
  $$ insert into public.user_bans (user_id, reason)
     values ('81000000-0000-0000-0000-0000000000a3', '   ') $$,
  '23514',
  null,
  'a blank ban reason is rejected'
);

-- ---------------------------------------------------------------------------
-- admin_list_users: platform-admin gated roster with ban state joined in.

select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;

select is(
  (select ban_reason from public.admin_list_users()
    where id = '81000000-0000-0000-0000-0000000000a2'),
  'Chargeback abuse',
  'admin_list_users surfaces the ban reason'
);

select is(
  (select banned_by_email from public.admin_list_users()
    where id = '81000000-0000-0000-0000-0000000000a2'),
  'ban-operator@pgtap.example',
  'admin_list_users resolves who banned to an email'
);

select is(
  (select count(*)::int from public.user_bans),
  1,
  'a platform admin reads the ban roster under their own RLS session'
);

-- A non-admin gets nothing: the RPC raises and RLS hides the table.
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-0000000000a3', true);

select throws_ok(
  $$ select * from public.admin_list_users() $$,
  'P0001',
  'platform admin required',
  'admin_list_users refuses non-admins'
);

select is(
  (select count(*)::int from public.user_bans),
  0,
  'RLS hides ban records from non-admins'
);

reset role;

-- ---------------------------------------------------------------------------
-- Unban is one transaction: the lockout and the record clear together, keys
-- stay revoked, and clearing a never-banned account is an idempotent no-op.

select public.clear_user_ban('81000000-0000-0000-0000-0000000000a2');

select is(
  (select count(*)::int from public.user_bans
    where user_id = '81000000-0000-0000-0000-0000000000a2'),
  0,
  'unban removes the ban record'
);

select is(
  (select banned_until from auth.users where id = '81000000-0000-0000-0000-0000000000a2'),
  null::timestamptz,
  'unban clears GoTrue banned_until in the same transaction'
);

select isnt(
  (select revoked_at from public.api_keys where id = '81000000-0000-0000-0000-0000000000b1'),
  null::timestamptz,
  'keys revoked at ban time stay revoked after unban'
);

select isnt(
  (select revoked_at from public.platform_admin_keys
    where id = '81000000-0000-0000-0000-0000000000c1'),
  null::timestamptz,
  'superadmin keys revoked at ban time stay revoked after unban'
);

select lives_ok(
  $$ select public.clear_user_ban('81000000-0000-0000-0000-0000000000a2') $$,
  'unbanning an account that is not banned is a no-op'
);

-- ---------------------------------------------------------------------------
-- Deleting the auth user also removes the ban record (cleanup trigger), so
-- no orphaned ban rows outlive their account.

select public.record_user_ban(
  '81000000-0000-0000-0000-0000000000a3',
  '81000000-0000-0000-0000-0000000000a1',
  'Cleanup check'
);
delete from auth.users where id = '81000000-0000-0000-0000-0000000000a3';

select is(
  (select count(*)::int from public.user_bans
    where user_id = '81000000-0000-0000-0000-0000000000a3'),
  0,
  'deleting the auth user removes their ban record'
);

select * from finish();

rollback;
