begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- public.unlock_founder_spend (migration
-- 20260826000000_decouple_spend_gate_from_login): when a user proves inbox
-- ownership, unlock spend ONLY for the org(s) they FOUNDED -- the earliest-joined
-- role='admin' membership. A later-invited admin must NOT be able to unlock a
-- founder's org (that would let an attacker who instant-signed-up a victim's
-- address invite a second admin they control and drain the victim's org without
-- proving the victim's inbox). Setting spend_unlocked_at also fires
-- rotate_credentials_on_spend_unlock.

update public.app_settings set signups_enabled = false;

-- Founder a1, later-invited admin a2 (both can log in: email_confirmed_at set).
insert into auth.users (id, email, email_confirmed_at) values
  ('67000000-0000-0000-0000-0000000000a1', 'founder@pgtap.example', now()),
  ('67000000-0000-0000-0000-0000000000a2', 'invited-admin@pgtap.example', now());

-- Org O1 is spend-locked (spend_unlocked_at null, via the org-insert default).
insert into public.organizations (id, slug, name) values
  ('67000000-0000-0000-0000-000000000001', 'pgtap-founder-o1', 'pgTAP Founder O1');
-- A memberless locked org O3: no founder, so nobody can unlock it.
insert into public.organizations (id, slug, name) values
  ('67000000-0000-0000-0000-000000000003', 'pgtap-founder-o3', 'pgTAP Founder O3');

-- Founding admin a1 joined FIRST (earliest created_at => the founder the trigger
-- and unlock_founder_spend key on); a2 is an attacker-added co-admin the reclaim
-- must evict. Explicit timestamps pin a1 as strictly earlier so a1 is the founder.
insert into public.organization_members (org_id, user_id, role, created_at) values
  ('67000000-0000-0000-0000-000000000001', '67000000-0000-0000-0000-0000000000a1',
   'admin', now() - interval '1 hour'),
  ('67000000-0000-0000-0000-000000000001', '67000000-0000-0000-0000-0000000000a2',
   'admin', now() - interval '1 minute');

-- A key the founder minted while locked (its instant-signup key -- MUST survive
-- unlock), and one the attacker-added co-admin minted (revoked on unlock).
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('67000000-0000-0000-0000-0000000000b1', '67000000-0000-0000-0000-000000000001',
   'founder key', 'xpl_f1', encode(sha256('f-k1'::bytea), 'hex'),
   '67000000-0000-0000-0000-0000000000a1'),
  ('67000000-0000-0000-0000-0000000000b2', '67000000-0000-0000-0000-000000000001',
   'co-admin key', 'xpl_f2', encode(sha256('f-k2'::bytea), 'hex'),
   '67000000-0000-0000-0000-0000000000a2');

-- Sessions: the co-admin's session (must NOT survive unlock), and two founder
-- sessions -- a stale pre-unlock one and a fresh verifying one -- BOTH of which
-- must survive (the founder's own credentials are never rotated).
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('67000000-0000-0000-0000-0000000000c2', '67000000-0000-0000-0000-0000000000a2',
   now() - interval '30 minutes', now() - interval '30 minutes'),
  ('67000000-0000-0000-0000-0000000000c1', '67000000-0000-0000-0000-0000000000a1',
   now() - interval '30 minutes', now() - interval '30 minutes'),
  ('67000000-0000-0000-0000-0000000000c3', '67000000-0000-0000-0000-0000000000a1',
   now(), now());

-- ---------------------------------------------------------------------------
-- 1. A LATER-invited admin cannot unlock the founder's org.

select public.unlock_founder_spend('67000000-0000-0000-0000-0000000000a2');

select is(
  (select spend_unlocked_at from public.organizations
    where id = '67000000-0000-0000-0000-000000000001'),
  null::timestamptz,
  'a later-invited admin does NOT unlock the founder''s org'
);

-- ---------------------------------------------------------------------------
-- 2. The FOUNDING admin (earliest membership) unlocks it.

select public.unlock_founder_spend('67000000-0000-0000-0000-0000000000a1');

select isnt(
  (select spend_unlocked_at from public.organizations
    where id = '67000000-0000-0000-0000-000000000001'),
  null::timestamptz,
  'the founding (earliest) admin unlocks the org'
);

-- ---------------------------------------------------------------------------
-- 3. The founder's own instant key SURVIVES unlock (it must keep working through
--    and after verification -- rotation never touches the founder's credentials).

select is(
  (select revoked_at from public.api_keys where id = '67000000-0000-0000-0000-0000000000b1'),
  null::timestamptz,
  'the founder''s instant key SURVIVES unlock (never revoked)'
);

-- Reclaim evicts the attacker-added co-admin so they cannot mint a fresh key and
-- spend after unlock; the founding admin stays, and the co-admin's pre-unlock key
-- is revoked too.
select is(
  (select pg_catalog.count(*)::pg_catalog.int4 from public.organization_members
    where org_id = '67000000-0000-0000-0000-000000000001'
      and user_id = '67000000-0000-0000-0000-0000000000a2'),
  0,
  'a co-admin added while locked is evicted from the org on unlock'
);

select is(
  (select pg_catalog.count(*)::pg_catalog.int4 from public.organization_members
    where org_id = '67000000-0000-0000-0000-000000000001'
      and user_id = '67000000-0000-0000-0000-0000000000a1'),
  1,
  'the founding admin is retained on unlock'
);

select isnt(
  (select revoked_at from public.api_keys where id = '67000000-0000-0000-0000-0000000000b2'),
  null::timestamptz,
  'the co-admin''s pre-unlock key is revoked on unlock'
);

-- The co-admin's session must NOT survive (the "attacker admin session survives
-- unlock" defense); BOTH of the founder's sessions survive (their credentials are
-- never rotated).
select is(
  (select pg_catalog.count(*)::pg_catalog.int4 from auth.sessions
    where id = '67000000-0000-0000-0000-0000000000c2'),
  0,
  'the co-admin''s session is severed on unlock (cannot mint post-unlock)'
);

select is(
  (select pg_catalog.count(*)::pg_catalog.int4 from auth.sessions
    where id = '67000000-0000-0000-0000-0000000000c1'),
  1,
  'the founder''s stale pre-unlock session SURVIVES (founder sessions untouched)'
);

select is(
  (select pg_catalog.count(*)::pg_catalog.int4 from auth.sessions
    where id = '67000000-0000-0000-0000-0000000000c3'),
  1,
  'the founder''s fresh verifying session survives'
);

-- ---------------------------------------------------------------------------
-- 4. Idempotent: a second unlock for the founder is a no-op and does not error.

select lives_ok(
  $$select public.unlock_founder_spend('67000000-0000-0000-0000-0000000000a1')$$,
  'a second unlock for the founder is a harmless no-op'
);

select isnt(
  (select spend_unlocked_at from public.organizations
    where id = '67000000-0000-0000-0000-000000000001'),
  null::timestamptz,
  'the org stays unlocked after the idempotent second call'
);

-- ---------------------------------------------------------------------------
-- 5. A memberless org has no founder, so no one unlocks it.

select public.unlock_founder_spend('67000000-0000-0000-0000-0000000000a1');
select public.unlock_founder_spend('67000000-0000-0000-0000-0000000000a2');

select is(
  (select spend_unlocked_at from public.organizations
    where id = '67000000-0000-0000-0000-000000000003'),
  null::timestamptz,
  'a memberless org is never unlocked (it has no founding admin)'
);

select * from finish();

rollback;
