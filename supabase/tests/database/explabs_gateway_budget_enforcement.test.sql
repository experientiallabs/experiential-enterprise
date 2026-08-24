begin;

create extension if not exists pgtap with schema extensions;

select plan(36);

-- gw-identity P-C: per-scope monthly BUDGETS enforced at the reservation seam
-- (migration 20260820100000). Budgets compose ALONGSIDE billing's caps -- both
-- must pass -- and are host_managed, reserve-time, lock-serialized, and
-- reservation-aware, exactly like the caps in gateway_start_attempt. The caps
-- and balance gate themselves stay pinned by explabs_gateway_runtime.test.sql
-- and explabs_gateway_billing_policy.test.sql; this suite pins the budget gate.

-- ---------------------------------------------------------------------------
-- 0. Cutover preservation, asserted BEFORE any budget is inserted: P-A seeded
--    no budget rows, so a matching budget can never exist at cutover and the
--    reservation path is unchanged until an operator sets one.

-- Scoped to this suite's fixture orgs: seed-demo.sql legitimately arms demo
-- budgets on a seeded database, and global state is not this suite's to pin.
select is(
  (select pg_catalog.count(*) from public.gateway_budgets
    where org_id in ('63000000-0000-0000-0000-000000000001',
                     '63000000-0000-0000-0000-000000000002')),
  0::pg_catalog.int8,
  'cutover: P-A seeded no budgets, so nothing is capped until an operator sets one'
);

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Org E is the budgeted org, topped up so it is not free-credit funded (the
-- $50/$25 daily caps are off) and granted plenty of balance, so budgets are the
-- only reserve-time gate that can fire. Org F has NO budgets, for the
-- unlimited-passes proof at the seam.

insert into public.organizations (id, slug, name) values
  ('63000000-0000-0000-0000-000000000001', 'pgtap-pc-tenant-e', 'pgTAP Budget E'),
  ('63000000-0000-0000-0000-000000000002', 'pgtap-pc-tenant-f', 'pgTAP Budget F');

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
values ('63000000-0000-0000-0000-000000000001', 'grant', 10000, 'pgTAP headroom', 'admin');
insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source, source_ref)
values ('63000000-0000-0000-0000-000000000001', 'topup', 5, 'pgTAP top-up',
        'stripe', 'cs_test_pgtap_pc');
insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
values ('63000000-0000-0000-0000-000000000002', 'grant', 100, 'pgTAP headroom', 'admin');

-- Identities: org E's default plus three named principals; org F's default.
insert into public.gateway_identities (identity_id, org_id, display_name) values
  ('org-63000000-0000-0000-0000-000000000001',
   '63000000-0000-0000-0000-000000000001', 'Default'),
  ('alpha', '63000000-0000-0000-0000-000000000001', 'Alpha'),
  ('beta',  '63000000-0000-0000-0000-000000000001', 'Beta'),
  ('gamma', '63000000-0000-0000-0000-000000000001', 'Gamma'),
  ('org-63000000-0000-0000-0000-000000000002',
   '63000000-0000-0000-0000-000000000002', 'Default')
on conflict (identity_id) do nothing;
-- The default identities ('org-' || org_id) are already seeded by the new-org
-- trigger when the orgs were inserted above; on conflict keeps the named
-- principals (alpha/beta/gamma) while composing with that trigger.

-- Keys reparented onto their identities (the value P-A's backfill would set).
insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id) values
  ('63000000-0000-0000-0000-000000000011', '63000000-0000-0000-0000-000000000001',
   'k-default', 'xpl_pcd', encode(sha256('pc-kd'::bytea), 'hex'), null,
   'org-63000000-0000-0000-0000-000000000001'),
  ('63000000-0000-0000-0000-000000000012', '63000000-0000-0000-0000-000000000001',
   'k-alpha', 'xpl_pca', encode(sha256('pc-ka'::bytea), 'hex'), null, 'alpha'),
  ('63000000-0000-0000-0000-000000000013', '63000000-0000-0000-0000-000000000001',
   'k-beta', 'xpl_pcb', encode(sha256('pc-kb'::bytea), 'hex'), null, 'beta'),
  ('63000000-0000-0000-0000-000000000014', '63000000-0000-0000-0000-000000000001',
   'k-gamma', 'xpl_pcg', encode(sha256('pc-kg'::bytea), 'hex'), null, 'gamma'),
  ('63000000-0000-0000-0000-000000000015', '63000000-0000-0000-0000-000000000002',
   'k-orgf', 'xpl_pcf', encode(sha256('pc-kf'::bytea), 'hex'), null,
   'org-63000000-0000-0000-0000-000000000002');

-- Uncapped key limits so the rpm guard and per-key daily cap never mask a
-- budget verdict in the gateway_start_attempt tests.
insert into public.gateway_key_limits (api_key_id, daily_spend_cap_micro_usd, requests_per_minute)
select id, null, null from public.api_keys
 where org_id in ('63000000-0000-0000-0000-000000000001',
                  '63000000-0000-0000-0000-000000000002');

-- One alias/revision on a snapshot so pool/deployment scope can resolve an
-- attempt's alias through the request's frozen revision.
insert into public.gateway_catalog_snapshots (catalog_sha256, document, models_document)
  values (repeat('cd', 32), '{}'::jsonb, '{}'::jsonb);
insert into public.gateway_aliases (alias_id, alias_name, org_id, active, origin)
  values ('alias-cod', 'coding', '63000000-0000-0000-0000-000000000001', true, 'named');
insert into public.gateway_alias_revisions (
  revision_id, alias_id, target, catalog_sha256, provider_connection_revisions
) values (
  'rev-cod', 'alias-cod', '{"pool_id":"pool-cod"}'::jsonb, repeat('cd', 32), '{}'::jsonb
);

-- Carrier requests: attempts hang off a request, and identity/alias attribution
-- is resolved through the request (key -> identity; revision -> alias).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values
  ('pc-r-a', '63000000-0000-0000-0000-000000000001',
   '63000000-0000-0000-0000-000000000012', 'coding', 'rev-cod',
   'chat_completions', encode(sha256('pc-a'::bytea), 'hex'),
   now(), now() + interval '1 hour'),
  ('pc-r-d', '63000000-0000-0000-0000-000000000001',
   '63000000-0000-0000-0000-000000000011', 'coding', 'rev-cod',
   'chat_completions', encode(sha256('pc-d'::bytea), 'hex'),
   now(), now() + interval '1 hour'),
  ('pc-r-g', '63000000-0000-0000-0000-000000000001',
   '63000000-0000-0000-0000-000000000014', 'coding', 'rev-cod',
   'chat_completions', encode(sha256('pc-g'::bytea), 'hex'),
   now(), now() + interval '1 hour'),
  ('pc-r-b', '63000000-0000-0000-0000-000000000001',
   '63000000-0000-0000-0000-000000000013', 'coding', 'rev-cod',
   'chat_completions', encode(sha256('pc-b'::bytea), 'hex'),
   now(), now() + interval '1 hour');

-- Seeded this-month spend (started_at well outside the 60s rpm window). Amounts:
--   alpha (identity)      : $6 settled, pool-alpha/dep-alpha (off the pool/dep budgets)
--   pool-cod             : $12 settled, dep-other
--   dep-cod              : $3 settled  -> pool-cod total $15, dep-cod total $3
--   gamma (identity)      : $5 settled, at its own budget
-- and one PRIOR-month $50 beta attempt that must never count this month.
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, output_tokens, estimated_cost_micro_usd,
  budget_period_start, budget_reserved_micro_usd, budget_settled_micro_usd
) values
  ('pc-a-alpha', 'pc-r-a', '63000000-0000-0000-0000-000000000001', 0, 0,
   'dep-alpha', 'prov', 'm-a', 'pool-alpha', repeat('cd', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   100, 6000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   6000000, 6000000),
  ('pc-a-pool', 'pc-r-d', '63000000-0000-0000-0000-000000000001', 0, 0,
   'dep-other', 'prov', 'm-p', 'pool-cod', repeat('cd', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   100, 12000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   12000000, 12000000),
  ('pc-a-dep', 'pc-r-d', '63000000-0000-0000-0000-000000000001', 1, 0,
   'dep-cod', 'prov', 'm-d', 'pool-cod', repeat('cd', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   100, 3000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   3000000, 3000000),
  ('pc-a-gamma', 'pc-r-g', '63000000-0000-0000-0000-000000000001', 0, 0,
   'dep-gamma', 'prov', 'm-g', 'pool-gamma', repeat('cd', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   100, 5000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   5000000, 5000000),
  ('pc-a-beta-prior', 'pc-r-b', '63000000-0000-0000-0000-000000000001', 0, 0,
   'dep-beta', 'prov', 'm-b', 'pool-beta', repeat('cd', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   100, 50000000,
   ((date_trunc('month', now() at time zone 'UTC') - interval '1 day') at time zone 'UTC'),
   50000000, 50000000);

-- Budgets for this UTC month.
insert into public.gateway_budgets
  (budget_id, org_id, period, scope_kind, identity_id, alias_id, pool_id, deployment_id, limit_micro_usd)
values
  ('bud-team', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'team',
   null, null, null, null, 100000000),
  ('bud-alpha', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'identity',
   'alpha', null, null, null, 10000000),
  ('bud-beta', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'identity',
   'beta', null, null, null, 10000000),
  ('bud-gamma', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'identity',
   'gamma', null, null, null, 5000000),
  ('bud-pool', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'pool',
   null, 'alias-cod', 'pool-cod', null, 20000000),
  ('bud-dep', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'deployment',
   null, 'alias-cod', 'pool-cod', 'dep-cod', 5000000);

-- ---------------------------------------------------------------------------
-- 1. Unlimited passes at the seam: org F has no budget rows, so a real
--    reservation goes through untouched (today's behavior preserved).

select public.gateway_accept_request(
  'pc-rf', '63000000-0000-0000-0000-000000000002',
  '63000000-0000-0000-0000-000000000015', 'coding', 'rev-cod',
  'chat_completions', encode(sha256('pc-rf'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'pc-rf', '63000000-0000-0000-0000-000000000002', 0, 0,
    'dep-x', 'prov', 'm-x', 'pool-x', repeat('cd', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'an org with no budget rows reserves normally (unlimited scope passes)'
);

-- ---------------------------------------------------------------------------
-- 2. Scope-spend attribution: identity via the request key, pool/deployment
--    via the request's frozen alias revision.

select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'identity', null, 'alpha',
    null, null, null,
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),
    ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')),
  6000000::pg_catalog.int8,
  'identity spend is attributed through the request key'
);

select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'pool', null, null,
    'alias-cod', 'pool-cod', null,
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),
    ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')),
  15000000::pg_catalog.int8,
  'pool spend sums every attempt on the pool for the alias (pool-cod: $12 + $3)'
);

select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'deployment', null, null,
    'alias-cod', 'pool-cod', 'dep-cod',
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),
    ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')),
  3000000::pg_catalog.int8,
  'deployment spend narrows the pool sum to the one deployment'
);

-- ---------------------------------------------------------------------------
-- 3. Identity budget: exact fit admitted, first micro-dollar past it refused.

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 4000000)),
  true,
  'a worst case landing exactly on the identity budget is admitted'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 4000001)),
  'budget_identity',
  'the first micro-dollar past the identity budget is refused with the identity scope'
);

select alike(
  (select message from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 4000001)),
  '%identity alpha past its $10.00 monthly budget%',
  'the identity budget message names the scope, the limit, and that it is monthly'
);

-- ---------------------------------------------------------------------------
-- 3b. Unknown worst-case cost fails closed against a governing budget: a null
--     proposed cost cannot be bounded, so it is refused with the budget's scope
--     rather than reserving zero and overshooting on settlement. With no
--     governing budget the unknown cost still passes (today's behavior kept).

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, null)),
  false,
  'an unknown worst-case cost is refused against a governing identity budget'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, null)),
  'budget_identity',
  'the unknown-cost refusal carries the governing budget scope'
);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000002', null, null, null, null, null, null)),
  true,
  'an unknown worst-case cost still passes when no budget governs the scope'
);

-- ---------------------------------------------------------------------------
-- 4. Reservation-aware: an outstanding dispatched reservation counts, so two
--    reservations cannot jointly exceed the budget; releasing it frees headroom.

insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, budget_period_start, budget_reserved_micro_usd
) values (
  'pc-a-alpha-inflight', 'pc-r-a', '63000000-0000-0000-0000-000000000001', 1, 0,
  'dep-alpha', 'prov', 'm-a', 'pool-alpha', repeat('cd', 32), 'host_managed',
  'dispatched', now() - interval '10 minutes',
  (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
  3000000);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 2000000)),
  false,
  'an outstanding reservation ($6 settled + $3 in flight) leaves no room for $2 more'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 2000000)),
  'budget_identity',
  'the jointly-exceeding reservation is refused with the identity scope'
);

update public.gateway_attempts
   set state = 'failed', terminal_at = now(), budget_settled_micro_usd = 0
 where attempt_id = 'pc-a-alpha-inflight';

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 2000000)),
  true,
  'releasing the reservation frees its budget headroom ($6 + $2 fits $10)'
);

-- ---------------------------------------------------------------------------
-- 5. Pool and deployment budgets (deployment is checked tightest-first).

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'org-63000000-0000-0000-0000-000000000001',
    'alias-cod', 'pool-cod', 'dep-other', 5000000)),
  true,
  'a worst case landing exactly on the pool budget is admitted'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'org-63000000-0000-0000-0000-000000000001',
    'alias-cod', 'pool-cod', 'dep-other', 5000001)),
  'budget_pool',
  'the first micro-dollar past the pool budget is refused with the pool scope'
);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'org-63000000-0000-0000-0000-000000000001',
    'alias-cod', 'pool-cod', 'dep-cod', 2000000)),
  true,
  'a worst case landing exactly on the deployment budget is admitted'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'org-63000000-0000-0000-0000-000000000001',
    'alias-cod', 'pool-cod', 'dep-cod', 2000001)),
  'budget_deployment',
  'the first micro-dollar past the deployment budget is refused, tightest scope first'
);

-- ---------------------------------------------------------------------------
-- 6. Team budget and the all-clear path.

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'org-63000000-0000-0000-0000-000000000001',
    null, null, null, 200000000)),
  'budget_team',
  'a worst case past the org-wide team budget is refused with the team scope'
);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'org-63000000-0000-0000-0000-000000000001',
    null, null, null, 1000000)),
  true,
  'a dispatch matching no tight scope with team headroom is admitted'
);

-- ---------------------------------------------------------------------------
-- 7. UTC-month boundary: last month's $50 beta spend is invisible this month.

select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'identity', null, 'beta',
    null, null, null,
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),
    ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')),
  0::pg_catalog.int8,
  'this UTC month sees none of last month''s spend'
);

select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'identity', null, 'beta',
    null, null, null,
    ((date_trunc('month', now() at time zone 'UTC') - interval '1 month') at time zone 'UTC'),
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')),
  50000000::pg_catalog.int8,
  'the same spend is visible in last month''s window (boundary is real, not a filter bug)'
);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'beta', null, null, null, 10000000)),
  true,
  'beta''s current-month budget is untouched by last month''s $50 (fits its $10 this month)'
);

-- ---------------------------------------------------------------------------
-- 8. End to end at the reservation seam: a budget over its limit rejects the
--    dispatch before an attempt row is inserted, with the typed SQLSTATE;
--    a dispatch clear of every budget still reserves.

select public.gateway_accept_request(
  'pc-r-gamma-live', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000014', 'coding', 'rev-cod',
  'chat_completions', encode(sha256('pc-gamma-live'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

-- gamma already holds $5 settled at its $5 budget; any positive worst case
-- rejects, and identity budgets stop routing (P1017, not a deployment advance).
select throws_ok(
  $$select public.gateway_start_attempt(
    'pc-r-gamma-live', '63000000-0000-0000-0000-000000000001', 0, 0,
    'dep-free', 'prov', 'm-free', 'pool-free', repeat('cd', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  'P1017',
  null,
  'an identity over its monthly budget is rejected at the reservation seam (P1017)'
);

select public.gateway_accept_request(
  'pc-r-default-live', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'coding', 'rev-cod',
  'chat_completions', encode(sha256('pc-default-live'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select is(
  (select pg_catalog.count(*) from public.gateway_start_attempt(
    'pc-r-default-live', '63000000-0000-0000-0000-000000000001', 0, 0,
    'dep-free', 'prov', 'm-free', 'pool-free', repeat('cd', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)),
  1::pg_catalog.int8,
  'a dispatch clear of every budget still reserves with budgets present (caps + budgets compose)'
);

-- Both guards must live in the FINAL applied gateway_start_attempt body. Three
-- migrations CREATE OR REPLACE it; the last timestamp wins on a fresh
-- migrate-all. The P1017 case above proves the budget block survived; this
-- proves the price-unknown P1013 guard did too, in the SAME final body. If the
-- last redefinition ever drops EITHER guard, one of these two fails. The guard
-- fires before the balance/cap/budget checks, so an unknown price is P1013
-- regardless of this key's budget headroom.
select public.gateway_accept_request(
  'pc-r-unpriced-live', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'coding', 'rev-cod',
  'chat_completions', encode(sha256('pc-unpriced-live'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select public.gateway_start_attempt(
    'pc-r-unpriced-live', '63000000-0000-0000-0000-000000000001', 0, 0,
    'dep-free', 'prov', 'm-free', 'pool-free', repeat('cd', 32),
    'host_managed', null, null, null, null, null, null, null)$$,
  'P1013',
  null,
  'an unknown-priced host route is ineligible (P1013) in the same final body '
    || 'that enforces budgets — proves both guards survived the last redefinition'
);

-- ---------------------------------------------------------------------------
-- 9. Key and model scopes, and recurring ('*') budgets (20260822120000).

-- Mimic the 20260822110000 backfill for the directly-seeded attempts above:
-- live dispatches stamp api_key_id at reserve time, fixtures inherit it here.
update public.gateway_attempts attempts
   set api_key_id = requests.api_key_id
  from public.gateway_requests requests
 where requests.request_id = attempts.request_id
   and attempts.api_key_id is null;

insert into public.gateway_budgets
  (budget_id, org_id, period, scope_kind, api_key_id, identity_id, alias_id,
   pool_id, deployment_id, limit_micro_usd)
values
  -- key scope: alpha's key ($8) and gamma's key ($4, already exceeded by the
  -- $5 settled fixture).
  ('bud-key-alpha', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'key',
   '63000000-0000-0000-0000-000000000012', null, null, null, null, 8000000),
  ('bud-key-gamma', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'key',
   '63000000-0000-0000-0000-000000000014', null, null, null, null, 4000000),
  -- model scope: the alias across every pool/deployment under it.
  ('bud-model', '63000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'model',
   null, null, 'alias-cod', null, null, 30000000),
  -- recurring: enforced every month against that month's own spend.
  ('bud-rec-alpha', '63000000-0000-0000-0000-000000000001',
   '*', 'identity', null, 'alpha', null, null, null, 7000000),
  ('bud-rec-beta', '63000000-0000-0000-0000-000000000001',
   '*', 'identity', null, 'beta', null, null, null, 40000000);

select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'key',
    '63000000-0000-0000-0000-000000000012', null, null, null, null,
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),
    ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')),
  6000000::pg_catalog.int8,
  'key spend reads the attempt''s own denormalized api_key_id ($6 settled + $0 released)'
);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001',
    '63000000-0000-0000-0000-000000000012', null, null, null, null, 2000000)),
  true,
  'a worst case landing exactly on the key budget is admitted ($6 + $2 fits $8)'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001',
    '63000000-0000-0000-0000-000000000012', null, null, null, null, 2000001)),
  'budget_key',
  'the first micro-dollar past the key budget is refused with the key scope'
);

-- Model spend through the frozen revision: $6 (alpha) + $12 + $3 (pool/dep)
-- + $5 (gamma) settled plus the $1 reservation from section 8's live dispatch.
select is(
  public.gateway_budget_scope_spent(
    '63000000-0000-0000-0000-000000000001', 'model', null, null,
    'alias-cod', null, null,
    (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),
    ((date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC')),
  27000000::pg_catalog.int8,
  'model spend sums every pool/deployment under the alias, reservations included'
);

select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, null,
    'alias-cod', 'pool-other', null, 3000000)),
  true,
  'a worst case landing exactly on the model budget is admitted ($27 + $3 fits $30)'
);

select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, null,
    'alias-cod', 'pool-other', null, 3000001)),
  'budget_model',
  'the first micro-dollar past the model budget is refused with the model scope'
);

-- Recurring rows enforce in the current month...
select is(
  (select reason_code from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'alpha', null, null, null, 1500000)),
  'budget_identity',
  'a recurring (*) budget enforces this month (alpha: $6 + $1.50 breaks its recurring $7)'
);

-- ...and measure ONLY the current month: beta carries $50 of last-month spend,
-- which a recurring $40 budget must not see (its pinned $10 admits the exact
-- fit; if recurring counted last month, $50 + $10 > $40 would refuse).
select is(
  (select allowed from public.gateway_budget_reservation_check(
    '63000000-0000-0000-0000-000000000001', null, 'beta', null, null, null, 10000000)),
  true,
  'a recurring (*) budget measures the current month only (last month''s $50 is invisible)'
);

-- End to end: the key budget rejects at the reservation seam with P1023,
-- checked tighter than the identity budget that would also refuse.
select public.gateway_accept_request(
  'pc-r-key-live', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000014', 'coding', 'rev-cod',
  'chat_completions', encode(sha256('pc-key-live'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select public.gateway_start_attempt(
    'pc-r-key-live', '63000000-0000-0000-0000-000000000001', 0, 0,
    'dep-free', 'prov', 'm-free', 'pool-free', repeat('cd', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 1000000)$$,
  'P1023',
  null,
  'a key over its monthly budget is rejected at the reservation seam (P1023, tighter than identity)'
);

-- End to end: the model budget rejects with P1024 for a key that is clear of
-- every key/identity budget.
select public.gateway_accept_request(
  'pc-r-model-live', '63000000-0000-0000-0000-000000000001',
  '63000000-0000-0000-0000-000000000011', 'coding', 'rev-cod',
  'chat_completions', encode(sha256('pc-model-live'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

select throws_ok(
  $$select public.gateway_start_attempt(
    'pc-r-model-live', '63000000-0000-0000-0000-000000000001', 0, 0,
    'dep-free', 'prov', 'm-free', 'pool-free', repeat('cd', 32),
    'host_managed', 'launch_catalog', now(),
    2000000, null, 10000000, null, 5000000)$$,
  'P1024',
  null,
  'a model (alias) over its monthly budget is rejected at the reservation seam (P1024)'
);

select * from finish();

rollback;
