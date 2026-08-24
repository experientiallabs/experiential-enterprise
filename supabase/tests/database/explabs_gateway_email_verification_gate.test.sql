begin;

create extension if not exists pgtap with schema extensions;

select plan(7);

-- The credit spend gate (migration
-- 20260826000000_decouple_spend_gate_from_login, SQLSTATE P1025) enforced at the
-- reservation seam inside gateway_start_attempt. An org whose founding 'admin'
-- membership exists but whose organizations.spend_unlocked_at is null may not
-- draw PLATFORM credits; BYOK, trace uploads, and dashboard reads are
-- unaffected. This is the money half of instant signup: a real, usable org key
-- is issued immediately and the user is LOGGED IN (email_confirm:true), but the
-- credit grant stays locked until the founder proves inbox ownership, which sets
-- spend_unlocked_at. Login and spend-unlock are DECOUPLED: the gate no longer
-- reads auth.users.email_confirmed_at. The gate fires FIRST in the host-lane
-- block (before the price/balance/budget checks) and only when a present admin
-- membership exists. The balance/cap/budget guards stay pinned by
-- explabs_gateway_runtime / billing_policy / budget_enforcement; this suite pins
-- the spend gate and re-proves the P1013 price guard survives in the same final
-- composed body.

-- Signups off so a bare auth.users insert does NOT auto-provision an org: this
-- suite seeds deterministic fixed-UUID orgs and memberships itself.
update public.app_settings set signups_enabled = false;

-- Two founders. Both can log in (email_confirmed_at set, as signup now does
-- eagerly); whether their org can SPEND is governed by spend_unlocked_at below.
insert into auth.users (id, email, email_confirmed_at) values
  ('64000000-0000-0000-0000-0000000000a1', 'unlocked@pgtap.example', now());
insert into auth.users (id, email, email_confirmed_at) values
  ('64000000-0000-0000-0000-0000000000a2', 'locked@pgtap.example', now());

-- Three orgs: V owned by a founder whose spend is UNLOCKED, U by a founder whose
-- spend is LOCKED (spend_unlocked_at null), W with no membership at all (the
-- fixture/seed shape every existing host-lane suite uses, which the gate must
-- never block).
insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('64000000-0000-0000-0000-000000000001', 'pgtap-ev-unlocked', 'pgTAP Unlocked', now()),
  ('64000000-0000-0000-0000-000000000002', 'pgtap-ev-locked',   'pgTAP Locked',   null),
  ('64000000-0000-0000-0000-000000000003', 'pgtap-ev-memberless', 'pgTAP Memberless', null);

-- Ample balance on every org so the ONLY thing a host reservation can trip is
-- the spend gate (or, deliberately, the price-unknown guard).
insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source) values
  ('64000000-0000-0000-0000-000000000001', 'grant', 10000, 'pgTAP headroom', 'admin'),
  ('64000000-0000-0000-0000-000000000002', 'grant', 10000, 'pgTAP headroom', 'admin'),
  ('64000000-0000-0000-0000-000000000003', 'grant', 10000, 'pgTAP headroom', 'admin');

-- Founding admin memberships for V and U; W is left membership-less on purpose.
insert into public.organization_members (org_id, user_id, role) values
  ('64000000-0000-0000-0000-000000000001', '64000000-0000-0000-0000-0000000000a1', 'admin'),
  ('64000000-0000-0000-0000-000000000002', '64000000-0000-0000-0000-0000000000a2', 'admin');

-- One key per org, on the org's default identity (seeded by the new-org trigger).
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id) values
  ('64000000-0000-0000-0000-0000000000b1', '64000000-0000-0000-0000-000000000001',
   'k-unlocked', 'xpl_evv', encode(sha256('ev-kv'::bytea), 'hex'), null,
   'org-64000000-0000-0000-0000-000000000001'),
  ('64000000-0000-0000-0000-0000000000b2', '64000000-0000-0000-0000-000000000002',
   'k-locked', 'xpl_evu', encode(sha256('ev-ku'::bytea), 'hex'), null,
   'org-64000000-0000-0000-0000-000000000002'),
  ('64000000-0000-0000-0000-0000000000b3', '64000000-0000-0000-0000-000000000003',
   'k-memberless', 'xpl_evm', encode(sha256('ev-km'::bytea), 'hex'), null,
   'org-64000000-0000-0000-0000-000000000003');

-- Uncapped key limits so no rpm/daily-cap guard masks the spend-gate verdict.
insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
select id, null, null from public.api_keys
 where org_id in ('64000000-0000-0000-0000-000000000001',
                  '64000000-0000-0000-0000-000000000002',
                  '64000000-0000-0000-0000-000000000003');

-- One snapshot; one alias + frozen revision per org for accept_request.
insert into public.gateway_catalog_snapshots (catalog_sha256, document, models_document)
  values (repeat('ef', 32), '{}'::jsonb, '{}'::jsonb);
insert into public.gateway_aliases (alias_id, alias_name, org_id, active, origin) values
  ('ev-alias-v', 'coding', '64000000-0000-0000-0000-000000000001', true, 'named'),
  ('ev-alias-u', 'coding', '64000000-0000-0000-0000-000000000002', true, 'named'),
  ('ev-alias-w', 'coding', '64000000-0000-0000-0000-000000000003', true, 'named');
insert into public.gateway_alias_revisions
  (revision_id, alias_id, target, catalog_sha256, provider_connection_revisions) values
  ('ev-rev-v', 'ev-alias-v', '{"pool_id":"pool-ev"}'::jsonb, repeat('ef', 32), '{}'::jsonb),
  ('ev-rev-u', 'ev-alias-u', '{"pool_id":"pool-ev"}'::jsonb, repeat('ef', 32), '{}'::jsonb),
  ('ev-rev-w', 'ev-alias-w', '{"pool_id":"pool-ev"}'::jsonb, repeat('ef', 32), '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 1. Unlocked owner: a host-lane (platform-funded) reservation goes through.

select public.gateway_accept_request(
  'ev-r-unlocked', '64000000-0000-0000-0000-000000000001',
  '64000000-0000-0000-0000-0000000000b1', 'coding', 'ev-rev-v',
  'chat_completions', encode(sha256('ev-unlocked'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'ev-r-unlocked', '64000000-0000-0000-0000-000000000001', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'an unlocked owner reserves platform credits normally'
);

-- ---------------------------------------------------------------------------
-- 2. Locked owner: the same host-lane reservation is refused with P1025,
--    before any attempt row is inserted.

select public.gateway_accept_request(
  'ev-r-locked', '64000000-0000-0000-0000-000000000002',
  '64000000-0000-0000-0000-0000000000b2', 'coding', 'ev-rev-u',
  'chat_completions', encode(sha256('ev-locked'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select public.gateway_start_attempt(
    'ev-r-locked', '64000000-0000-0000-0000-000000000002', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  'P1025',
  null,
  'a spend-locked owner cannot draw platform credits (P1025 org_owner_unverified)'
);

-- ---------------------------------------------------------------------------
-- 3. Ordering: the gate fires BEFORE the price-unknown guard. A locked org
--    dispatching a null-priced route gets P1025, not P1013.

select public.gateway_accept_request(
  'ev-r-locked-noprice', '64000000-0000-0000-0000-000000000002',
  '64000000-0000-0000-0000-0000000000b2', 'coding', 'ev-rev-u',
  'chat_completions', encode(sha256('ev-locked-noprice'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select public.gateway_start_attempt(
    'ev-r-locked-noprice', '64000000-0000-0000-0000-000000000002', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'host_managed', null, null, null, null, null, null, null)$$,
  'P1025',
  null,
  'the spend gate precedes the price-unknown guard (P1025, not P1013)'
);

-- ---------------------------------------------------------------------------
-- 4. BYOK (customer_managed) skips the whole host block, so a locked org
--    dispatches on its own provider keys with no gate at all.

select public.gateway_accept_request(
  'ev-r-locked-byok', '64000000-0000-0000-0000-000000000002',
  '64000000-0000-0000-0000-0000000000b2', 'coding', 'ev-rev-u',
  'chat_completions', encode(sha256('ev-locked-byok'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'ev-r-locked-byok', '64000000-0000-0000-0000-000000000002', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'customer_managed', 'byok', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'a locked org still dispatches BYOK traffic (the gate is host-lane only)'
);

-- ---------------------------------------------------------------------------
-- 5. The price-unknown guard (P1013) still fires for an UNLOCKED org, proving
--    it survived alongside the new gate in the final composed function body.

select public.gateway_accept_request(
  'ev-r-unlocked-noprice', '64000000-0000-0000-0000-000000000001',
  '64000000-0000-0000-0000-0000000000b1', 'coding', 'ev-rev-v',
  'chat_completions', encode(sha256('ev-unlocked-noprice'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select public.gateway_start_attempt(
    'ev-r-unlocked-noprice', '64000000-0000-0000-0000-000000000001', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'host_managed', null, null, null, null, null, null, null)$$,
  'P1013',
  null,
  'the price-unknown guard survives in the same final body (P1013 for an unlocked org)'
);

-- ---------------------------------------------------------------------------
-- 6. A membership-less org (fixture/seed shape) is NEVER gated, even with
--    spend_unlocked_at null: the EXISTS guard only blocks a PRESENT admin.

select public.gateway_accept_request(
  'ev-r-memberless', '64000000-0000-0000-0000-000000000003',
  '64000000-0000-0000-0000-0000000000b3', 'coding', 'ev-rev-w',
  'chat_completions', encode(sha256('ev-memberless'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'ev-r-memberless', '64000000-0000-0000-0000-000000000003', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'an org with no membership is not gated (only a present locked admin is)'
);

-- ---------------------------------------------------------------------------
-- 7. Unlocking spend opens the gate: setting spend_unlocked_at on the locked
--    org U lets the SAME host-lane reservation through, with no other change.

update public.organizations
   set spend_unlocked_at = now()
 where id = '64000000-0000-0000-0000-000000000002';

select public.gateway_accept_request(
  'ev-r-unlocked-now', '64000000-0000-0000-0000-000000000002',
  '64000000-0000-0000-0000-0000000000b2', 'coding', 'ev-rev-u',
  'chat_completions', encode(sha256('ev-unlocked-now'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'ev-r-unlocked-now', '64000000-0000-0000-0000-000000000002', 0, 0,
    'dep-ev', 'prov', 'm-ev', 'pool-ev', repeat('ef', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'setting spend_unlocked_at opens the gate for the previously-locked org'
);

select * from finish();

rollback;
