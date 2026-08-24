begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

-- Pre-verify credit-spend allowance (migration
-- 20260828140000_gateway_start_attempt_promo_and_pre_verify). The P1025 gate no
-- longer blocks ALL platform-credit spend for an unverified org; it allows
-- cumulative charged-or-reserved credit spend up to app_settings
-- .pre_verify_allowance_micro_usd (default $1; column added by migration
-- 20260828160000, owned by the credits/admin workstream), read via
-- gateway_pre_verify_allowance_micro_usd, then blocks the rest with P1025. An
-- allowance of 0 restores the block-everything behavior; promo-free spend never
-- counts toward the allowance. The column already exists in the migrated schema,
-- so this suite UPDATEs it (default $1, then 0, then a custom $5) rather than
-- adding it.

update public.app_settings set signups_enabled = false;

insert into auth.users (id, email, email_confirmed_at) values
  ('66000000-0000-0000-0000-0000000000a1', 'pv-u@pgtap.example', now()),
  ('66000000-0000-0000-0000-0000000000a2', 'pv-r@pgtap.example', now()),
  ('66000000-0000-0000-0000-0000000000a3', 'pv-z@pgtap.example', now());

-- All three orgs are UNVERIFIED (spend_unlocked_at null) with a founding admin,
-- and each carries a large grant so the ONLY limiter under test is the pre-verify
-- allowance (never the balance gate, which sits after P1025).
insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('66000000-0000-0000-0000-000000000001', 'pgtap-pv-u', 'pgTAP PV U', null),
  ('66000000-0000-0000-0000-000000000002', 'pgtap-pv-r', 'pgTAP PV R', null),
  ('66000000-0000-0000-0000-000000000003', 'pgtap-pv-z', 'pgTAP PV Z', null);

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source) values
  ('66000000-0000-0000-0000-000000000001', 'grant', 10000, 'pgTAP headroom', 'admin'),
  ('66000000-0000-0000-0000-000000000002', 'grant', 10000, 'pgTAP headroom', 'admin'),
  ('66000000-0000-0000-0000-000000000003', 'grant', 10000, 'pgTAP headroom', 'admin');

insert into public.organization_members (org_id, user_id, role) values
  ('66000000-0000-0000-0000-000000000001', '66000000-0000-0000-0000-0000000000a1', 'admin'),
  ('66000000-0000-0000-0000-000000000002', '66000000-0000-0000-0000-0000000000a2', 'admin'),
  ('66000000-0000-0000-0000-000000000003', '66000000-0000-0000-0000-0000000000a3', 'admin');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id) values
  ('66000000-0000-0000-0000-0000000000b1', '66000000-0000-0000-0000-000000000001',
   'k-u', 'xpl_pvu', encode(sha256('pv-ku'::bytea), 'hex'), null,
   'org-66000000-0000-0000-0000-000000000001'),
  ('66000000-0000-0000-0000-0000000000b2', '66000000-0000-0000-0000-000000000002',
   'k-r', 'xpl_pvr', encode(sha256('pv-kr'::bytea), 'hex'), null,
   'org-66000000-0000-0000-0000-000000000002'),
  ('66000000-0000-0000-0000-0000000000b3', '66000000-0000-0000-0000-000000000003',
   'k-z', 'xpl_pvz', encode(sha256('pv-kz'::bytea), 'hex'), null,
   'org-66000000-0000-0000-0000-000000000003');

-- Null key limits so no rpm/daily-cap guard masks the allowance verdict.
insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
select id, null, null from public.api_keys
 where org_id in ('66000000-0000-0000-0000-000000000001',
                  '66000000-0000-0000-0000-000000000002',
                  '66000000-0000-0000-0000-000000000003');

-- A promo model for the promo-exclusion test (org R).
insert into public.models (slug, display_name) values
  ('pv-promo', 'PV Promo'),
  ('pv-nopromo', 'PV No Promo');
insert into public.model_promotions (id, label, per_org_cap_micro_usd, cap_scope, active, display_order)
values ('66000000-0000-0000-0000-0000000000c1', 'pv-promo', 5000000, 'lifetime', true, 0);
insert into public.model_promotion_models (promotion_id, model_id, slug)
select '66000000-0000-0000-0000-0000000000c1', models.id, models.slug
from public.models where models.slug = 'pv-promo' and models.owning_org_id is null;

-- ---------------------------------------------------------------------------
-- Default $1 allowance (app_settings column absent -> helper returns 1_000_000).
-- Org U accrues charged-or-reserved credit spend across reservations.

-- 1. First $0.60 reservation: cumulative 0 + 600_000 <= 1_000_000 -> allowed.
select public.gateway_accept_request(
  'u-r1', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-0000000000b1', 'nopromo-u', 'rev-u1',
  'chat_completions', encode(sha256('u-r1'::bytea), 'hex'), null, now() + interval '1 hour');
select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'u-r1', '66000000-0000-0000-0000-000000000001', 0, 0,
    'dep-u', 'prov', 'm-u', 'pool-u', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 600000)),
  1::pg_catalog.int8,
  'unverified org spends under the $1 pre-verify allowance');

-- 2. A $0.50 reservation now: cumulative 600_000 + 500_000 = 1_100_000 > 1_000_000 -> P1025.
select public.gateway_accept_request(
  'u-r2', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-0000000000b1', 'nopromo-u', 'rev-u2',
  'chat_completions', encode(sha256('u-r2'::bytea), 'hex'), null, now() + interval '1 hour');
select throws_ok(
  $$select public.gateway_start_attempt(
    'u-r2', '66000000-0000-0000-0000-000000000001', 0, 0,
    'dep-u', 'prov', 'm-u', 'pool-u', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 500000)$$,
  'P1025', null,
  'unverified org is blocked (P1025) once it would exceed the $1 allowance');

-- 3. A $0.40 reservation fits exactly at the allowance: 600_000 + 400_000 = 1_000_000 -> allowed.
select public.gateway_accept_request(
  'u-r3', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-0000000000b1', 'nopromo-u', 'rev-u3',
  'chat_completions', encode(sha256('u-r3'::bytea), 'hex'), null, now() + interval '1 hour');
select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'u-r3', '66000000-0000-0000-0000-000000000001', 0, 0,
    'dep-u', 'prov', 'm-u', 'pool-u', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 400000)),
  1::pg_catalog.int8,
  'a reservation that fits exactly at the allowance is admitted');

-- 4. One more micro-dollar now exceeds it -> P1025.
select public.gateway_accept_request(
  'u-r4', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-0000000000b1', 'nopromo-u', 'rev-u4',
  'chat_completions', encode(sha256('u-r4'::bytea), 'hex'), null, now() + interval '1 hour');
select throws_ok(
  $$select public.gateway_start_attempt(
    'u-r4', '66000000-0000-0000-0000-000000000001', 0, 0,
    'dep-u', 'prov', 'm-u', 'pool-u', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 1)$$,
  'P1025', null,
  'the first micro-dollar past the allowance is blocked (no allowance overdraft)');

-- ---------------------------------------------------------------------------
-- 5-6. Promo-free spend does NOT count toward the allowance. Org R uses a promo
-- model free (skips P1025 entirely), then a non-promo credit request still sees
-- zero prior credit spend and fits under the $1 allowance.

select public.gateway_accept_request(
  'r-promo', '66000000-0000-0000-0000-000000000002',
  '66000000-0000-0000-0000-0000000000b2', 'pv-promo', 'rev-rp',
  'chat_completions', encode(sha256('r-promo'::bytea), 'hex'), null, now() + interval '1 hour');
select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'r-promo', '66000000-0000-0000-0000-000000000002', 0, 0,
    'dep-rp', 'prov', 'm-rp', 'pool-rp', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 2000000)),
  1::pg_catalog.int8,
  'an unverified org uses a promo model free (the pre-verify gate is skipped)');

select public.gateway_accept_request(
  'r-credit', '66000000-0000-0000-0000-000000000002',
  '66000000-0000-0000-0000-0000000000b2', 'pv-nopromo', 'rev-rc',
  'chat_completions', encode(sha256('r-credit'::bytea), 'hex'), null, now() + interval '1 hour');
select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'r-credit', '66000000-0000-0000-0000-000000000002', 0, 0,
    'dep-rc', 'prov', 'm-rc', 'pool-rc', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 900000)),
  1::pg_catalog.int8,
  'the prior promo-free spend did not consume the credit allowance (900k still fits under $1)');

-- ---------------------------------------------------------------------------
-- 7. Allowance 0 == block ALL unverified credit spend. The column exists in the
-- migrated schema (migration 20260828160000); set it to 0 for this case.

update public.app_settings set pre_verify_allowance_micro_usd = 0;

select public.gateway_accept_request(
  'z-r1', '66000000-0000-0000-0000-000000000003',
  '66000000-0000-0000-0000-0000000000b3', 'nopromo-z', 'rev-z1',
  'chat_completions', encode(sha256('z-r1'::bytea), 'hex'), null, now() + interval '1 hour');
select throws_ok(
  $$select public.gateway_start_attempt(
    'z-r1', '66000000-0000-0000-0000-000000000003', 0, 0,
    'dep-z', 'prov', 'm-z', 'pool-z', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 1)$$,
  'P1025', null,
  'allowance 0 blocks all unverified credit spend (prior behavior)');

-- ---------------------------------------------------------------------------
-- 8. A custom allowance is honored: raise it to $5 and org U (1_000_000 already
-- reserved) admits a further $2 reservation (3_000_000 <= 5_000_000).

update public.app_settings set pre_verify_allowance_micro_usd = 5000000;
select public.gateway_accept_request(
  'u-r5', '66000000-0000-0000-0000-000000000001',
  '66000000-0000-0000-0000-0000000000b1', 'nopromo-u', 'rev-u5',
  'chat_completions', encode(sha256('u-r5'::bytea), 'hex'), null, now() + interval '1 hour');
select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'u-r5', '66000000-0000-0000-0000-000000000001', 0, 0,
    'dep-u', 'prov', 'm-u', 'pool-u', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(), 1000000, null, 2000000, null, 2000000)),
  1::pg_catalog.int8,
  'a custom allowance from app_settings is honored ($5 admits the further $2)');

select * from finish();

rollback;
