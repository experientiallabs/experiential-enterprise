begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Configurable spend-unlock requirement (migration
-- 20260827130000_spend_unlock_requirement_flag): a platform-wide MODE flag on
-- app_settings selects WHICH event opens the P1025 credit gate --
-- 'email' (default, inbox proof) or 'card' (a saved Stripe payment method) --
-- plus public.unlock_org_spend, the org-scoped 'card' unlock primitive that
-- fires the SAME credential rotation as the founder path.

-- ---------------------------------------------------------------------------
-- 1. The flag ships defaulting to 'email' on the seeded singleton row, so
--    behavior is unchanged until an operator flips it.

select is(
  (select spend_unlock_requirement from public.app_settings where singleton),
  'email',
  'spend_unlock_requirement defaults to ''email'' (nothing changes now)'
);

-- ---------------------------------------------------------------------------
-- 2. The flag is a closed enum: an out-of-contract value is rejected, so the
--    unlock contract can never be silently set to a meaningless mode.

select throws_ok(
  $$ update public.app_settings set spend_unlock_requirement = 'bogus' where singleton $$,
  '23514',
  null,
  'spend_unlock_requirement rejects a value outside (''email'', ''card'')'
);

-- ---------------------------------------------------------------------------
-- Fixture: a spend-locked org whose founding admin a1 minted a key while
-- locked, and an attacker-added non-founder co-admin a2 (later membership) with
-- their own key -- exactly the shape the rotation must reclaim, so the card
-- unlock can be shown to rotate identically to the founder unlock.

update public.app_settings set signups_enabled = false where singleton;

insert into auth.users (id, email, email_confirmed_at) values
  ('68000000-0000-0000-0000-0000000000a1', 'card-founder@pgtap.example', now()),
  ('68000000-0000-0000-0000-0000000000a2', 'card-coadmin@pgtap.example', now());

insert into public.organizations (id, slug, name) values
  ('68000000-0000-0000-0000-000000000001', 'pgtap-card-o1', 'pgTAP Card O1');

insert into public.organization_members (org_id, user_id, role, created_at) values
  ('68000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-0000000000a1',
   'admin', now() - interval '1 hour'),
  ('68000000-0000-0000-0000-000000000001', '68000000-0000-0000-0000-0000000000a2',
   'admin', now() - interval '1 minute');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('68000000-0000-0000-0000-0000000000b1', '68000000-0000-0000-0000-000000000001',
   'founder key', 'xpl_c1', encode(sha256('c-k1'::bytea), 'hex'),
   '68000000-0000-0000-0000-0000000000a1'),
  ('68000000-0000-0000-0000-0000000000b2', '68000000-0000-0000-0000-000000000001',
   'co-admin key', 'xpl_c2', encode(sha256('c-k2'::bytea), 'hex'),
   '68000000-0000-0000-0000-0000000000a2');

-- ---------------------------------------------------------------------------
-- 3. unlock_org_spend opens the gate on the given org (the 'card' unlock event).

select public.unlock_org_spend('68000000-0000-0000-0000-000000000001');

select isnt(
  (select spend_unlocked_at from public.organizations
    where id = '68000000-0000-0000-0000-000000000001'),
  null::timestamptz,
  'unlock_org_spend sets spend_unlocked_at (opens the P1025 gate)'
);

-- 4. It is idempotent: a retried webhook cannot move an already-open timestamp.
create temp table _first_unlock as
  select spend_unlocked_at as ts from public.organizations
   where id = '68000000-0000-0000-0000-000000000001';

select public.unlock_org_spend('68000000-0000-0000-0000-000000000001');

select is(
  (select spend_unlocked_at from public.organizations
    where id = '68000000-0000-0000-0000-000000000001'),
  (select ts from _first_unlock),
  'unlock_org_spend is idempotent: a second call does not move the timestamp'
);

-- 5. An unknown org is a no-op, never an error (a webhook for a deleted org).
select lives_ok(
  $$ select public.unlock_org_spend('68000000-0000-0000-0000-0000000000ff') $$,
  'unlock_org_spend no-ops on an unknown org'
);

-- ---------------------------------------------------------------------------
-- 6-8. The card unlock fires the SAME rotation as the founder path: the
--      attacker-added non-founder co-admin is evicted and their key revoked,
--      while the founding admin's own instant key SURVIVES.

select is(
  (select pg_catalog.count(*)::pg_catalog.int4 from public.organization_members
    where org_id = '68000000-0000-0000-0000-000000000001'
      and user_id = '68000000-0000-0000-0000-0000000000a2'),
  0,
  'card unlock evicts the attacker-added non-founder co-admin (rotation fired)'
);

select isnt(
  (select revoked_at from public.api_keys where id = '68000000-0000-0000-0000-0000000000b2'),
  null::timestamptz,
  'card unlock revokes the co-admin''s pre-unlock key'
);

select is(
  (select revoked_at from public.api_keys where id = '68000000-0000-0000-0000-0000000000b1'),
  null::timestamptz,
  'card unlock PRESERVES the founding admin''s own key (never revoked)'
);

select * from finish();

rollback;
