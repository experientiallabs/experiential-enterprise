begin;

create extension if not exists pgtap with schema extensions;

select plan(35);

-- Scoped promotions (v2, migration 20260829000000) enforced at the
-- reservation seam inside gateway_start_attempt. Config lives in
-- public.model_promotions + model_promotion_models (model scope) + providers
-- (lane scope); free usage is tracked in the promo_* columns on
-- gateway_attempts so it never draws org credits. State machine per (org,
-- promotion): under free cap -> promo-funded (free); cap reached, not
-- notified -> P1030 (one-time promo->credits notice); cap reached, notified,
-- credits cover -> credits path (discounted while under the promotion's
-- charged-spend ceiling); cap reached, notified, credits gone -> P1031
-- (BYOK-only). This suite pins each transition, the promo accounting on the
-- attempt row, the lifetime-vs-recurring window, lane scoping, the discount
-- ceiling, and the free cap shared across a promotion's model set.

-- Deterministic fixtures; no signup auto-provisioning, and no welcome grant —
-- orgs P/Q's balances must be exactly what this file gives them (the grant
-- trigger reads app_settings.welcome_grant_micro_usd, which a seeded local
-- database sets to $20; an unseeded one has no settings row and grants
-- nothing, so zero it explicitly for both environments).
update public.app_settings set signups_enabled = false, welcome_grant_micro_usd = 0;

-- Two founders, both able to log in; both orgs have spend unlocked so the ONLY
-- thing under test is the promo cap (not the P1025 spend gate).
insert into auth.users (id, email, email_confirmed_at) values
  ('65000000-0000-0000-0000-0000000000a1', 'promo-p@pgtap.example', now()),
  ('65000000-0000-0000-0000-0000000000a2', 'promo-q@pgtap.example', now());

-- Org P: NO credits (proves promo is free -- it succeeds with an empty balance).
-- Org Q: funded (proves the post-cap credits fallback).
insert into public.organizations (id, slug, name, spend_unlocked_at) values
  ('65000000-0000-0000-0000-000000000001', 'pgtap-promo-p', 'pgTAP Promo P', now()),
  ('65000000-0000-0000-0000-000000000002', 'pgtap-promo-q', 'pgTAP Promo Q', now());

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source) values
  ('65000000-0000-0000-0000-000000000002', 'grant', 10000, 'pgTAP headroom', 'admin');

insert into public.organization_members (org_id, user_id, role) values
  ('65000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-0000000000a1', 'admin'),
  ('65000000-0000-0000-0000-000000000002', '65000000-0000-0000-0000-0000000000a2', 'admin');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id) values
  ('65000000-0000-0000-0000-0000000000b1', '65000000-0000-0000-0000-000000000001',
   'k-p', 'xpl_pmp', encode(sha256('promo-kp'::bytea), 'hex'), null,
   'org-65000000-0000-0000-0000-000000000001'),
  ('65000000-0000-0000-0000-0000000000b2', '65000000-0000-0000-0000-000000000002',
   'k-q', 'xpl_pmq', encode(sha256('promo-kq'::bytea), 'hex'), null,
   'org-65000000-0000-0000-0000-000000000002');

-- Uncapped key limits so no rpm/daily guard masks the promo verdict.
insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
select id, null, null from public.api_keys
 where org_id in ('65000000-0000-0000-0000-000000000001',
                  '65000000-0000-0000-0000-000000000002');

-- Public catalog models the promotions target (slug == the model field / alias).
insert into public.models (slug, display_name) values
  ('promo-a', 'Promo A (cap $5)'),
  ('promo-b', 'Promo B (cap $1)'),
  ('promo-c', 'Promo C (cap $5)'),
  ('promo-d', 'Promo D (pure 50% off)'),
  ('promo-e', 'Promo E (50% off via one lane, $1.50 ceiling)'),
  ('promo-f1', 'Promo F1 (shared $3 cap)'),
  ('promo-f2', 'Promo F2 (shared $3 cap)'),
  ('nopromo', 'No Promotion');

-- Promotions (v2). Free caps chosen so a 2_000_000 ($2) worst case is UNDER
-- promo-a/c ($5) and OVER promo-b ($1). promo-d is a pure uncapped 50%
-- discount; promo-e is 50% off ONLY via the experiential_cloud lane with a
-- $1.50 per-org charged-spend ceiling; promo-f shares one $3 free cap across
-- two models. Fixed ids so notices and scope edits can name promotions.
insert into public.model_promotions
  (id, label, per_org_cap_micro_usd, discount_cap_micro_usd, cap_scope, percent_off, providers, active, display_order)
values
  ('65000000-0000-0000-0000-0000000000c1', 'promo-a', 5000000, 0, 'lifetime', 0, '{}', true, 0),
  ('65000000-0000-0000-0000-0000000000c2', 'promo-b', 1000000, 0, 'lifetime', 0, '{}', true, 1),
  ('65000000-0000-0000-0000-0000000000c3', 'promo-c', 5000000, 0, 'lifetime', 0, '{}', true, 2),
  ('65000000-0000-0000-0000-0000000000c4', 'promo-d', 0, 0, 'lifetime', 50, '{}', true, 3),
  ('65000000-0000-0000-0000-0000000000c5', 'promo-e', 0, 1500000, 'lifetime', 50,
   array['experiential_cloud'], true, 4),
  ('65000000-0000-0000-0000-0000000000c6', 'promo-f', 3000000, 0, 'lifetime', 0, '{}', true, 5);

insert into public.model_promotion_models (promotion_id, model_id, slug)
select scope.promotion_id::uuid, models.id, models.slug
from (values
  ('65000000-0000-0000-0000-0000000000c1', 'promo-a'),
  ('65000000-0000-0000-0000-0000000000c2', 'promo-b'),
  ('65000000-0000-0000-0000-0000000000c3', 'promo-c'),
  ('65000000-0000-0000-0000-0000000000c4', 'promo-d'),
  ('65000000-0000-0000-0000-0000000000c5', 'promo-e'),
  ('65000000-0000-0000-0000-0000000000c6', 'promo-f1'),
  ('65000000-0000-0000-0000-0000000000c6', 'promo-f2')
) as scope(promotion_id, slug)
join public.models on public.models.slug = scope.slug and public.models.owning_org_id is null;

-- ---------------------------------------------------------------------------
-- 1-4. UNDER CAP -> promo-funded (free). Org P has ZERO credits, yet a promo-a
-- request reserves; the attempt is promo_funded with 0 in the credit column and
-- its worst case in the promo column.

select public.gateway_accept_request(
  'p-r-free', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'promo-a', 'rev-free',
  'chat_completions', encode(sha256('p-free'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table free_attempt as
select attempt_id from public.gateway_start_attempt(
  'p-r-free', '65000000-0000-0000-0000-000000000001', 0, 0,
  'dep-a', 'prov', 'm-a', 'pool-a', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  1000000, null, 2000000, null, 2000000);

select is((select pg_catalog.count(*) from free_attempt), 1::pg_catalog.int8,
  'under-cap promo request reserves for an org with no credits (free)');
select is(
  (select promo_funded from public.gateway_attempts a join free_attempt using (attempt_id)),
  true, 'the under-cap attempt is promo_funded');
select is(
  (select budget_reserved_micro_usd from public.gateway_attempts a join free_attempt using (attempt_id)),
  0::pg_catalog.int8, 'a promo-funded attempt reserves 0 credit dollars');
select is(
  (select promo_reserved_micro_usd from public.gateway_attempts a join free_attempt using (attempt_id)),
  2000000::pg_catalog.int8, 'a promo-funded attempt reserves its worst case against the promo cap');

-- ---------------------------------------------------------------------------
-- 5. A NON-promo model on the same zero-credit org draws credits and is refused
-- for lack of balance (P1010) -- proving promo funding, not the org, bypassed
-- the balance gate above.

select public.gateway_accept_request(
  'p-r-nopromo', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'nopromo', 'rev-nopromo',
  'chat_completions', encode(sha256('p-nopromo'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select throws_ok(
  $$select public.gateway_start_attempt(
    'p-r-nopromo', '65000000-0000-0000-0000-000000000001', 0, 0,
    'dep-n', 'prov', 'm-n', 'pool-n', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    1000000, null, 2000000, null, 2000000)$$,
  'P1010', null,
  'a non-promo model on a zero-credit org is refused (P1010), so promo bypassed the balance gate');

-- ---------------------------------------------------------------------------
-- 6. CAP REACHED, not yet notified -> P1030 promo_exhausted_notice. promo-b's
-- $1 cap cannot cover a $2 worst case, so the first request is over cap.

select public.gateway_accept_request(
  'p-r-over', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'promo-b', 'rev-over',
  'chat_completions', encode(sha256('p-over'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select throws_ok(
  $$select public.gateway_start_attempt(
    'p-r-over', '65000000-0000-0000-0000-000000000001', 0, 0,
    'dep-b', 'prov', 'm-b', 'pool-b', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    1000000, null, 2000000, null, 2000000)$$,
  'P1030', null,
  'promo over cap, org not yet notified, refuses with the one-time notice (P1030)');

-- ---------------------------------------------------------------------------
-- 7-9. CAP REACHED, notified, credits cover -> credits path. Org Q is funded;
-- mark it notified for promo-b (the ledger normally commits this out of band
-- after a P1030). The over-cap request now reserves on CREDITS.

insert into public.model_promotion_notices (org_id, promotion_id, period_key) values
  ('65000000-0000-0000-0000-000000000002', '65000000-0000-0000-0000-0000000000c2', 'lifetime');

select public.gateway_accept_request(
  'q-r-credits', '65000000-0000-0000-0000-000000000002',
  '65000000-0000-0000-0000-0000000000b2', 'promo-b', 'rev-credits',
  'chat_completions', encode(sha256('q-credits'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table credit_attempt as
select attempt_id from public.gateway_start_attempt(
  'q-r-credits', '65000000-0000-0000-0000-000000000002', 0, 0,
  'dep-b', 'prov', 'm-b', 'pool-b', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  1000000, null, 2000000, null, 2000000);

select is((select pg_catalog.count(*) from credit_attempt), 1::pg_catalog.int8,
  'a notified org with credits reserves the exhausted promo model on credits');
select is(
  (select promo_funded from public.gateway_attempts a join credit_attempt using (attempt_id)),
  false, 'the post-notice attempt draws credits, not promo (promo_funded false)');
select cmp_ok(
  (select budget_reserved_micro_usd from public.gateway_attempts a join credit_attempt using (attempt_id)),
  '>', 0::pg_catalog.int8, 'the post-notice attempt reserves against credits');

-- ---------------------------------------------------------------------------
-- 10. CAP REACHED, notified, credits gone -> P1031 promo_byok_only. Org P
-- (zero credits), marked notified for promo-b, is over cap with no credits: the
-- model becomes BYOK-only for that org.

insert into public.model_promotion_notices (org_id, promotion_id, period_key) values
  ('65000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-0000000000c2', 'lifetime');

select public.gateway_accept_request(
  'p-r-byok', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'promo-b', 'rev-byok',
  'chat_completions', encode(sha256('p-byok'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select throws_ok(
  $$select public.gateway_start_attempt(
    'p-r-byok', '65000000-0000-0000-0000-000000000001', 0, 0,
    'dep-b', 'prov', 'm-b', 'pool-b', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    1000000, null, 2000000, null, 2000000)$$,
  'P1031', null,
  'promo exhausted + notified + no credits is BYOK-only for the org (P1031)');

-- ---------------------------------------------------------------------------
-- 11-12. LIFETIME vs RECURRING cap window. Reserve a promo-c attempt for org P
-- and backdate it 40 days. A lifetime cap counts it; a recurring (monthly) cap
-- does not, so the same org is under cap again in the new month.

select public.gateway_accept_request(
  'p-r-recur', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'promo-c', 'rev-recur',
  'chat_completions', encode(sha256('p-recur'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table recur_attempt as
select attempt_id from public.gateway_start_attempt(
  'p-r-recur', '65000000-0000-0000-0000-000000000001', 0, 0,
  'dep-c', 'prov', 'm-c', 'pool-c', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  1000000, null, 2000000, null, 2000000);
update public.gateway_attempts
   set budget_period_start = date_trunc('month', (now() - interval '40 days') at time zone 'UTC') at time zone 'UTC'
 where attempt_id in (select attempt_id from recur_attempt);

select is(
  (select promo_spent_micro_usd from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'promo-c', 'prov', 1000000)),
  2000000::pg_catalog.int8,
  'a LIFETIME cap counts promo spend from a prior month');

update public.model_promotions set cap_scope = 'recurring'
 where id = '65000000-0000-0000-0000-0000000000c3';
select is(
  (select promo_spent_micro_usd from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'promo-c', 'prov', 1000000)),
  0::pg_catalog.int8,
  'a RECURRING cap excludes prior-month promo spend (resets monthly)');

-- ---------------------------------------------------------------------------
-- 13-14. gateway_promo_state discriminates promo from non-promo slugs.

select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'promo-a', 'prov', 1000000)),
  true, 'gateway_promo_state reports a promotional slug as promo');
select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'nopromo', 'prov', 1000000)),
  false, 'gateway_promo_state reports a non-promotional slug as not promo');

-- ---------------------------------------------------------------------------
-- 15-17. Settlement of a promo-funded attempt NEVER draws org credits: the cost
-- lands in promo_settled_micro_usd, budget_settled stays 0, and the org's
-- billable_spend_usd is untouched.

select public.gateway_settle_attempt(
  (select attempt_id from free_attempt), 'completed', null,
  1000, null, 2000, null, 'observed', true);

select is(
  (select billable_spend_usd from public.organizations
    where id = '65000000-0000-0000-0000-000000000001'),
  0::pg_catalog.numeric, 'settling a promo-funded attempt does not draw org credits');
select cmp_ok(
  (select promo_settled_micro_usd from public.gateway_attempts a join free_attempt using (attempt_id)),
  '>', 0::pg_catalog.int8, 'the promo-funded attempt records its settled cost in the promo column');
select is(
  (select budget_settled_micro_usd from public.gateway_attempts a join free_attempt using (attempt_id)),
  0::pg_catalog.int8, 'the promo-funded attempt settles 0 against credits');

-- ---------------------------------------------------------------------------
-- 18-24. PURE DISCOUNT (cap 0, percent_off 50). Org Q (funded) requests promo-d:
-- no free tier, so no P1030 -- it draws credits from the first request at 50%
-- off. The reservation and the settled charge are both halved; estimated_cost
-- keeps the full cost; the org is billed only the discounted amount.

select public.gateway_accept_request(
  'q-r-disc', '65000000-0000-0000-0000-000000000002',
  '65000000-0000-0000-0000-0000000000b2', 'promo-d', 'rev-disc',
  'chat_completions', encode(sha256('q-disc'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table disc_attempt as
select attempt_id from public.gateway_start_attempt(
  'q-r-disc', '65000000-0000-0000-0000-000000000002', 0, 0,
  'dep-d', 'prov', 'm-d', 'pool-d', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  0, null, 1000000, null, 2000000);

select is((select pg_catalog.count(*) from disc_attempt), 1::pg_catalog.int8,
  'a pure-discount promo (cap 0) reserves on credits from the first request (no P1030)');
select is(
  (select promo_funded from public.gateway_attempts a join disc_attempt using (attempt_id)),
  false, 'a pure-discount promo attempt draws credits (not promo-funded)');
select is(
  (select budget_reserved_micro_usd from public.gateway_attempts a join disc_attempt using (attempt_id)),
  1000000::pg_catalog.int8, 'the credit reservation is the discounted worst case (50% off $2 = $1)');
select is(
  (select promo_discount_percent from public.gateway_attempts a join disc_attempt using (attempt_id)),
  50::pg_catalog.numeric, 'the attempt freezes its 50% discount for settlement');

-- Settle with $1 of full cost (1_000_000 output tokens @ $1/Mtok output rate).
select public.gateway_settle_attempt(
  (select attempt_id from disc_attempt), 'completed', null,
  0, null, 1000000, null, 'observed', true);

select is(
  (select budget_settled_micro_usd from public.gateway_attempts a join disc_attempt using (attempt_id)),
  500000::pg_catalog.int8, 'the settled charge is the full cost discounted 50% ($1 -> $0.50)');
select is(
  (select estimated_cost_micro_usd from public.gateway_attempts a join disc_attempt using (attempt_id)),
  1000000::pg_catalog.int8, 'estimated_cost_micro_usd keeps the FULL (undiscounted) cost');
select is(
  (select billable_spend_usd from public.organizations
    where id = '65000000-0000-0000-0000-000000000002'),
  0.5::pg_catalog.numeric, 'the org is billed only the discounted amount ($0.50)');

-- ---------------------------------------------------------------------------
-- 25-27. LANE SCOPE. promo-e discounts ONLY the experiential_cloud lane: an
-- attempt on any other provider sees no promotion at all (full-price
-- reservation), an attempt on the named lane reserves at 50% off.

select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000002', 'promo-e', 'openai', 2000000)),
  false, 'a lane-scoped promotion does not match an attempt on another provider');

select public.gateway_accept_request(
  'q-r-lane-miss', '65000000-0000-0000-0000-000000000002',
  '65000000-0000-0000-0000-0000000000b2', 'promo-e', 'rev-lane-miss',
  'chat_completions', encode(sha256('q-lane-miss'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table lane_miss_attempt as
select attempt_id from public.gateway_start_attempt(
  'q-r-lane-miss', '65000000-0000-0000-0000-000000000002', 0, 0,
  'dep-e', 'openai', 'm-e', 'pool-e', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  0, null, 1000000, null, 2000000);
select is(
  (select budget_reserved_micro_usd from public.gateway_attempts a join lane_miss_attempt using (attempt_id)),
  2000000::pg_catalog.int8,
  'an off-lane attempt on a lane-scoped promo model reserves FULL price');

select public.gateway_accept_request(
  'q-r-lane-hit', '65000000-0000-0000-0000-000000000002',
  '65000000-0000-0000-0000-0000000000b2', 'promo-e', 'rev-lane-hit',
  'chat_completions', encode(sha256('q-lane-hit'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table lane_hit_attempt as
select attempt_id from public.gateway_start_attempt(
  'q-r-lane-hit', '65000000-0000-0000-0000-000000000002', 0, 0,
  'dep-e', 'experiential_cloud', 'm-e', 'pool-e', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  0, null, 1000000, null, 2000000);
select is(
  (select budget_reserved_micro_usd from public.gateway_attempts a join lane_hit_attempt using (attempt_id)),
  1000000::pg_catalog.int8,
  'an on-lane attempt reserves the discounted worst case (50% off $2 = $1)');

-- ---------------------------------------------------------------------------
-- 28-29. DISCOUNT CEILING. Settle the on-lane attempt at $2 full cost -> $1
-- charged, exactly the org's remaining headroom under promo-e's $1.50 ceiling
-- ... so the NEXT on-lane request ($1 discounted worst case; $1 + $1 > $1.50)
-- pays list price: the promotion still matches, but discount_active is off.

select public.gateway_settle_attempt(
  (select attempt_id from lane_hit_attempt), 'completed', null,
  0, null, 2000000, null, 'observed', true);
select is(
  (select budget_settled_micro_usd from public.gateway_attempts a join lane_hit_attempt using (attempt_id)),
  1000000::pg_catalog.int8,
  'the on-lane settled charge is the full cost discounted 50% ($2 -> $1)');

select public.gateway_accept_request(
  'q-r-lane-capped', '65000000-0000-0000-0000-000000000002',
  '65000000-0000-0000-0000-0000000000b2', 'promo-e', 'rev-lane-capped',
  'chat_completions', encode(sha256('q-lane-capped'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
create temp table lane_capped_attempt as
select attempt_id from public.gateway_start_attempt(
  'q-r-lane-capped', '65000000-0000-0000-0000-000000000002', 0, 0,
  'dep-e', 'experiential_cloud', 'm-e', 'pool-e', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  0, null, 1000000, null, 2000000);
select is(
  (select budget_reserved_micro_usd from public.gateway_attempts a join lane_capped_attempt using (attempt_id)),
  2000000::pg_catalog.int8,
  'past the charged-spend ceiling the same lane pays list price (discount off)');

-- ---------------------------------------------------------------------------
-- 30. SHARED FREE CAP. promo-f's $3 free cap spans promo-f1 AND promo-f2 for
-- one org: a $2 free reservation on f1 leaves only $1, so a $2 request on f2
-- is over the SHARED cap and fires the one-time notice (P1030).

select public.gateway_accept_request(
  'p-r-shared-1', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'promo-f1', 'rev-shared-1',
  'chat_completions', encode(sha256('p-shared-1'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select public.gateway_start_attempt(
  'p-r-shared-1', '65000000-0000-0000-0000-000000000001', 0, 0,
  'dep-f', 'prov', 'm-f1', 'pool-f', repeat('ab', 32),
  'host_managed', 'launch_catalog', now(),
  1000000, null, 2000000, null, 2000000);
select public.gateway_accept_request(
  'p-r-shared-2', '65000000-0000-0000-0000-000000000001',
  '65000000-0000-0000-0000-0000000000b1', 'promo-f2', 'rev-shared-2',
  'chat_completions', encode(sha256('p-shared-2'::bytea), 'hex'),
  null, now() + interval '1 hour'
);
select throws_ok(
  $$select public.gateway_start_attempt(
    'p-r-shared-2', '65000000-0000-0000-0000-000000000001', 0, 0,
    'dep-f', 'prov', 'm-f2', 'pool-f', repeat('ab', 32),
    'host_managed', 'launch_catalog', now(),
    1000000, null, 2000000, null, 2000000)$$,
  'P1030', null,
  'the free cap is shared across the promotion''s models (f1 spend exhausts f2)');

-- ---------------------------------------------------------------------------
-- 31-32. SCOPE SEMANTICS. A promotion with the deliberate covers_all_models
-- flag matches any model on its lanes; a promotion whose membership rows were
-- cascade-deleted (empty membership, NO flag) matches NOTHING — it narrows,
-- never silently widens to the whole catalog.

insert into public.model_promotions
  (id, label, per_org_cap_micro_usd, discount_cap_micro_usd, cap_scope, percent_off, providers, covers_all_models, active, display_order)
values
  ('65000000-0000-0000-0000-0000000000c7', 'promo-g all-models-via-fireworks',
   0, 0, 'lifetime', 10, array['fireworks'], true, true, 6);

select is(
  (select percent_off from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000002', 'nopromo', 'fireworks', 2000000)),
  10::pg_catalog.numeric,
  'a covers_all_models lane promotion matches any model served on its lane');

insert into public.models (slug, display_name) values ('promo-h1', 'Promo H1');
insert into public.model_promotions
  (id, label, per_org_cap_micro_usd, cap_scope, percent_off, providers, active, display_order)
values
  ('65000000-0000-0000-0000-0000000000c8', 'promo-h scoped',
   1000000, 'lifetime', 50, array['experiential_cloud'], true, 7);
insert into public.model_promotion_models (promotion_id, model_id, slug)
select '65000000-0000-0000-0000-0000000000c8', models.id, models.slug
  from public.models where models.slug = 'promo-h1' and models.owning_org_id is null;
-- Simulate the member model's deletion cascading through the membership.
delete from public.model_promotion_models
 where promotion_id = '65000000-0000-0000-0000-0000000000c8';

select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000002', 'promo-h1', 'experiential_cloud', 2000000)),
  false,
  'a cascade-emptied scope matches nothing (no silent widening to all models)');

-- ---------------------------------------------------------------------------
-- Funding scope filters gateway_promo_state on the (host_managed) money path.
-- promo-a is the sole promotion on its slug, so toggling its funding_scope
-- flips whether that slug has an applicable promotion. 'platform_funded' (the
-- default) and 'all' match here; 'byok' is filtered out (it must not discount
-- platform-funded traffic, and BYOK carries no platform charge).
update public.model_promotions
   set funding_scope = 'byok'
 where id = '65000000-0000-0000-0000-0000000000c1';
select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'promo-a', 'prov', 1000000)),
  false, 'a byok-scoped promotion is filtered out on the platform-funded path');

update public.model_promotions
   set funding_scope = 'all'
 where id = '65000000-0000-0000-0000-0000000000c1';
select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'promo-a', 'prov', 1000000)),
  true, 'an all-traffic promotion applies on the platform-funded path');

update public.model_promotions
   set funding_scope = 'platform_funded'
 where id = '65000000-0000-0000-0000-0000000000c1';
select is(
  (select is_promo from public.gateway_promo_state(
     '65000000-0000-0000-0000-000000000001', 'promo-a', 'prov', 1000000)),
  true, 'a platform_funded promotion (the default) applies on the platform-funded path');

select * from finish();

rollback;
