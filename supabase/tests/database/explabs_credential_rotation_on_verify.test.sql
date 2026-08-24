begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Credential rotation on SPEND UNLOCK (trigger rotate_credentials_on_spend_unlock;
-- founder-preserving form in migration
-- 20260827000000_founder_key_survives_spend_unlock): the welcome grant stays
-- applied at signup and the user is logged in immediately, but the org's spend
-- stays locked (organizations.spend_unlocked_at null). When the founder unlocks
-- spend by proving inbox ownership, the FOUNDING admin's own credentials are
-- PRESERVED -- their instant key and sessions keep working through and after
-- verification (only attacker-added non-founder members are rotated, covered by
-- explabs_spend_unlock_founder). This suite pins that the founder's key/sessions
-- and grant survive, and that unlocking one org never touches another. The
-- trigger fires on public.organizations (NULL->NOT NULL of spend_unlocked_at),
-- NOT on auth.users.email_confirmed_at (which is now set eagerly for login).

-- Signups off so a bare auth.users insert does not auto-provision; this suite
-- seeds fixed-UUID orgs/memberships/keys itself.
update public.app_settings set signups_enabled = false;

-- ---------------------------------------------------------------------------
-- A LOCKED owner (logged in: email_confirmed_at set) with an org, an eager
-- welcome grant, a key they minted, and a session. The grant is present
-- immediately; the key/session are live while spend is locked.

insert into auth.users (id, email, email_confirmed_at) values
  ('66000000-0000-0000-0000-0000000000a1', 'rotate-owner@pgtap.example', now());
-- The org-insert trigger applies the eager $20 welcome grant automatically. Born
-- spend-locked (spend_unlocked_at null).
insert into public.organizations (id, slug, name) values
  ('66000000-0000-0000-0000-000000000001', 'pgtap-rotate', 'pgTAP Rotate');
insert into public.organization_members (org_id, user_id, role) values
  ('66000000-0000-0000-0000-000000000001', '66000000-0000-0000-0000-0000000000a1', 'admin');
-- A key the owner minted while locked (the instant-signup key).
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('66000000-0000-0000-0000-0000000000b1', '66000000-0000-0000-0000-000000000001',
   'instant key', 'xpl_rot1', encode(sha256('rot-k1'::bytea), 'hex'),
   '66000000-0000-0000-0000-0000000000a1');
-- A stale session from a zero-click /signup (created well before the unlock).
-- As a FOUNDER session it must survive unlock (only non-founder members rotate).
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('66000000-0000-0000-0000-0000000000d1', '66000000-0000-0000-0000-0000000000a1',
   now() - interval '1 hour', now() - interval '1 hour');

select is(
  (select credit_granted_usd from public.organizations
    where id = '66000000-0000-0000-0000-000000000001'),
  20.000000::numeric,
  'the $20 welcome grant is present at signup (pre-grant UX preserved)'
);

select is(
  (select revoked_at from public.api_keys where id = '66000000-0000-0000-0000-0000000000b1'),
  null::timestamptz,
  'the pre-unlock key is live while spend is locked (works for non-spend)'
);

-- ---------------------------------------------------------------------------
-- Unlocking spend PRESERVES the founder's credentials: grant untouched, the
-- founder's instant key kept, and all the founder's sessions kept.

-- A fresh "unlocking" session created at ~unlock time must survive.
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('66000000-0000-0000-0000-0000000000d2', '66000000-0000-0000-0000-0000000000a1',
   now(), now());

-- The same founder also owns a key in a DIFFERENT, already-unlocked org. Rotation
-- of org 1 must NOT touch it (revocation is scoped to keys.org_id = the unlocking
-- org, not merely created_by the founder).
insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('66000000-0000-0000-0000-000000000004', 'pgtap-rotate-other', 'pgTAP Rotate Other', now());
insert into public.organization_members (org_id, user_id, role) values
  ('66000000-0000-0000-0000-000000000004', '66000000-0000-0000-0000-0000000000a1', 'admin');
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('66000000-0000-0000-0000-0000000000b4', '66000000-0000-0000-0000-000000000004',
   'other-org key', 'xpl_rot4', encode(sha256('rot-k4'::bytea), 'hex'),
   '66000000-0000-0000-0000-0000000000a1');

update public.organizations set spend_unlocked_at = now()
 where id = '66000000-0000-0000-0000-000000000001';

select is(
  (select credit_granted_usd from public.organizations
    where id = '66000000-0000-0000-0000-000000000001'),
  20.000000::numeric,
  'unlocking leaves the welcome grant intact'
);

select is(
  (select revoked_at from public.api_keys where id = '66000000-0000-0000-0000-0000000000b1'),
  null::timestamptz,
  'the founder''s instant key SURVIVES unlock (never revoked)'
);

select is(
  (select count(*)::int from auth.sessions where id = '66000000-0000-0000-0000-0000000000d1'),
  1,
  'the founder''s stale pre-unlock session SURVIVES (founder sessions untouched)'
);

select is(
  (select count(*)::int from auth.sessions where id = '66000000-0000-0000-0000-0000000000d2'),
  1,
  'the founder''s session created at unlock survives'
);

select is(
  (select revoked_at from public.api_keys where id = '66000000-0000-0000-0000-0000000000b4'),
  null::timestamptz,
  'unlocking one org never revokes the founder''s key in a DIFFERENT org'
);

-- ---------------------------------------------------------------------------
-- An ESTABLISHED (already-unlocked) org's keys must NOT be revoked: the trigger
-- fires only on the first NULL->NOT NULL transition, and an established org is
-- born unlocked (backfilled / seeded), so it never transitions again.

-- Born unlocked: the INSERT fires the trigger, but no members/keys exist yet, so
-- nothing is revoked.
insert into auth.users (id, email, email_confirmed_at) values
  ('66000000-0000-0000-0000-0000000000a2', 'founder@pgtap.example', now());
insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('66000000-0000-0000-0000-000000000002', 'pgtap-established', 'pgTAP Established', now());
insert into public.organization_members (org_id, user_id, role) values
  ('66000000-0000-0000-0000-000000000002', '66000000-0000-0000-0000-0000000000a2', 'admin');
-- The established org's key, created by its founding admin AFTER unlock.
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('66000000-0000-0000-0000-0000000000b2', '66000000-0000-0000-0000-000000000002',
   'established key', 'xpl_rot2', encode(sha256('rot-k2'::bytea), 'hex'),
   '66000000-0000-0000-0000-0000000000a2');

select is(
  (select revoked_at from public.api_keys where id = '66000000-0000-0000-0000-0000000000b2'),
  null::timestamptz,
  'an already-unlocked org''s keys are never revoked (no NULL->set transition)'
);

select * from finish();

rollback;
