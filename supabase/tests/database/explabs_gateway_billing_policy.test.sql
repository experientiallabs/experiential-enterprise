begin;

create extension if not exists pgtap with schema extensions;

select plan(39);

-- Billing policy seams (migration 20260819234500): the free-credit-funded
-- predicate with its admin cap-lift override, the $50/day org and $25/day
-- per-model free-credit caps with BC-P6's verbose YC-aware copy, and the
-- settlement debit with the unknown-cost review counter. The reservation-
-- aware balance gate itself stays pinned by explabs_gateway_runtime.test.sql.

create temporary table bp_vals (k text primary key, v text);

-- ---------------------------------------------------------------------------
-- Fixtures. Org C: $20 welcome grant (signup trigger) + $200 admin grant,
-- zero top-ups -> free-credit funded with plenty of balance, so the caps are
-- what blocks. Org D: welcome grant fully consumed -> zero balance.

insert into public.organizations (id, slug, name) values
  ('62000000-0000-0000-0000-000000000001', 'pgtap-bp-tenant-c', 'pgTAP Billing C'),
  ('62000000-0000-0000-0000-000000000002', 'pgtap-bp-tenant-d', 'pgTAP Billing D');

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
values ('62000000-0000-0000-0000-000000000001', 'grant', 200, 'pgTAP headroom', 'admin');

update public.organizations
   set billable_spend_usd = credit_granted_usd
 where id = '62000000-0000-0000-0000-000000000002';

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('62000000-0000-0000-0000-000000000011', '62000000-0000-0000-0000-000000000001',
   'bp-kc', 'xpl_bpkc', encode(sha256('bp-kc'::bytea), 'hex'), null);

-- Carrier request for direct-inserted attempt fixtures (attempts hang off a
-- request row; superuser inserts bypass the sanctioned write paths on
-- purpose so each cap scenario controls its own budget_period_start).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values (
  'bp-r-fix', '62000000-0000-0000-0000-000000000001',
  '62000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-x',
  'chat_completions', encode(sha256('bp-fix'::bytea), 'hex'),
  now(), now() + interval '1 hour'
);

-- Today: $24 settled on model-a and $24 on model-b (org total $48). A $99
-- pass-through settlement today and a $40 model-a settlement YESTERDAY must
-- both stay invisible to the caps (lane filter; UTC-midnight bucketing).
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, output_tokens, estimated_cost_micro_usd,
  budget_period_start, budget_reserved_micro_usd, budget_settled_micro_usd
) values
  ('bp-a-today-a', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 0, 0,
   'dep-1', 'prov-openai', 'model-a', 'pool-1', repeat('cd', 32),
   'host_managed', 'completed', now(), now(), 100, 24000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   24000000, 24000000),
  ('bp-a-today-b', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 1, 0,
   'dep-1', 'prov-openai', 'model-b', 'pool-1', repeat('cd', 32),
   'host_managed', 'completed', now(), now(), 100, 24000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   24000000, 24000000),
  ('bp-a-yesterday', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 2, 0,
   'dep-1', 'prov-openai', 'model-a', 'pool-1', repeat('cd', 32),
   'host_managed', 'completed', now() - interval '1 day',
   now() - interval '1 day', 100, 40000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
     - interval '1 day',
   40000000, 40000000),
  ('bp-a-byok', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 3, 0,
   'dep-1', 'prov-openai', 'model-a', 'pool-1', repeat('cd', 32),
   'customer_managed', 'completed', now(), now(), 100, 99000000,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   99000000, 99000000);

-- ---------------------------------------------------------------------------
-- 1. The funding-source predicate.

select is(
  public.gateway_org_free_credit_funded('62000000-0000-0000-0000-000000000001'),
  true,
  'grants alone (welcome + admin) leave an org free-credit funded'
);

-- ---------------------------------------------------------------------------
-- 2. Org daily cap: $48 already charged today; only today's platform-funded
--    attempts count (the $40 yesterday row and the $99 pass-through row are
--    on the wrong side of UTC midnight / the lane filter).

select is(
  (select allowed from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-c', 2000000)),
  true,
  'a worst case landing exactly on the $50/day org cap is admitted'
);

insert into bp_vals
select 'org_cap_msg', policy.message
  from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-c', 2000001) policy;

select is(
  (select reason_code from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-c', 2000001)),
  'org_daily_cap',
  'the first micro-dollar past the org cap is refused with the org scope'
);

select alike(
  (select v from bp_vals where k = 'org_cap_msg'),
  '%Free-credit accounts are limited to $50/day%',
  'the org cap message carries the verbatim limit copy'
);

select alike(
  (select v from bp_vals where k = 'org_cap_msg'),
  '%you''ve used $48.00 today; resets at 00:00 UTC%',
  'the org cap message reports today''s charged-or-reserved spend'
);

select alike(
  (select v from bp_vals where k = 'org_cap_msg'),
  '%https://platform.experientiallabs.ai/credits%',
  'the org cap message links the credits page at the launch hostname'
);

select unalike(
  (select v from bp_vals where k = 'org_cap_msg'),
  '%000-000-0000%',
  'a non-YC org never receives the support phone number'
);

-- ---------------------------------------------------------------------------
-- 3. Per-model daily cap: model-a holds $24 today.

select is(
  (select allowed from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-a', 1000000)),
  true,
  'a worst case landing exactly on the $25/day model cap is admitted'
);

insert into bp_vals
select 'model_cap_msg', policy.message
  from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-a', 1000001) policy;

select is(
  (select reason_code from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-a', 1000001)),
  'model_daily_cap',
  'the first micro-dollar past the model cap is refused with the model scope'
);

select alike(
  (select v from bp_vals where k = 'model_cap_msg'),
  '%limited to $25/day per model (you''ve used $24.00 on model-a today%',
  'the model cap message names the model and its spend'
);

select alike(
  (select v from bp_vals where k = 'model_cap_msg'),
  '%No model is forbidden%',
  'the model cap message offers switching models (no model is forbidden)'
);

-- ---------------------------------------------------------------------------
-- 4. Outstanding reservations count against the caps.

insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, budget_period_start, budget_reserved_micro_usd
) values
  ('bp-a-inflight', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 4, 0,
   'dep-1', 'prov-openai', 'model-c', 'pool-1', repeat('cd', 32),
   'host_managed', 'dispatched', now(),
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   10000000);

select is(
  (select reason_code from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-b', 1)),
  'org_daily_cap',
  'an in-flight reservation counts toward the org daily cap'
);

-- Release the reservation (zero-completion insurance shape) and the headroom
-- returns.
update public.gateway_attempts
   set state = 'failed', terminal_at = now(), budget_settled_micro_usd = 0
 where attempt_id = 'bp-a-inflight';

select is(
  (select allowed from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-b', 1)),
  true,
  'a released reservation frees its cap headroom'
);

-- ---------------------------------------------------------------------------
-- 5. YC variant: with an unexpired yc_launch grant the refusal copy appends
--    the support contact info, assembled from config (gateway_support_phone /
--    gateway_support_email) rather than baked literals, and never on the
--    ruled-out xplabs.ai domain. YC-company
--    status is the `yc` label + an unexpired yc_launch grant now, so the suffix
--    reads the grant's expiry from credit_ledger.

insert into public.credit_ledger
    (org_id, entry_type, amount_usd, reason, source, source_ref, expires_at)
values
  ('62000000-0000-0000-0000-000000000001', 'grant', 526, 'YC launch grant',
   'yc_launch', 'yc-launch:62000000-0000-0000-0000-000000000001',
   now() + interval '1 month');

-- Default config: the placeholder contact the accessors fall back to.
insert into bp_vals
select 'yc_cap_msg', policy.message
  from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-c', 2000001) policy;

select alike(
  (select v from bp_vals where k = 'yc_cap_msg'),
  '%text/call support at 000-000-0000%',
  'an unexpired YC launch grant appends the support phone from config'
);

select alike(
  (select v from bp_vals where k = 'yc_cap_msg'),
  '%email support@example.com and we''ll sort you out.%',
  'the YC contact email is the configured support address'
);

select unalike(
  (select v from bp_vals where k = 'yc_cap_msg'),
  '%xplabs.ai%',
  'the ruled-out xplabs.ai domain never appears in the error copy'
);

-- Config-driven, not hardcoded: overriding the settings flows into the copy.
select set_config('app.explabs_support_phone', '555-000-1234', true);
select set_config('app.explabs_support_email', 'founder@example.test', true);

insert into bp_vals
select 'yc_cfg_msg', policy.message
  from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-c', 2000001) policy;

select alike(
  (select v from bp_vals where k = 'yc_cfg_msg'),
  '%text/call support at 555-000-1234%',
  'the YC contact phone is assembled from the app.explabs_support_phone setting'
);

select alike(
  (select v from bp_vals where k = 'yc_cfg_msg'),
  '%email founder@example.test and we''ll sort you out.%',
  'the YC contact email is assembled from the app.explabs_support_email setting'
);

-- Restore the default contact for the remaining assertions.
select set_config('app.explabs_support_phone', '', true);
select set_config('app.explabs_support_email', '', true);

-- Force the grant expired to prove the suffix drops. credit_ledger is
-- append-only at runtime, so this test-only backfill disables the guard for the
-- one UPDATE (same sanctioned pattern the migration uses); it is simulating
-- time passing, not a real write path.
alter table public.credit_ledger disable trigger credit_ledger_append_only;
update public.credit_ledger set expires_at = now() - interval '1 second'
 where org_id = '62000000-0000-0000-0000-000000000001' and source = 'yc_launch';
alter table public.credit_ledger enable trigger credit_ledger_append_only;

select unalike(
  (select message from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-c', 2000001)),
  '%000-000-0000%',
  'an expired YC launch grant drops the contact suffix'
);

-- ---------------------------------------------------------------------------
-- 6. Admin cap-lift override.

update public.organizations
   set free_credit_caps_lifted_at = now()
 where id = '62000000-0000-0000-0000-000000000001';

select is(
  public.gateway_org_free_credit_funded('62000000-0000-0000-0000-000000000001'),
  false,
  'lifting the caps flips the predicate without a top-up'
);

select is(
  (select allowed from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-a', 60000000)),
  true,
  'a cap-lifted org spends past both daily caps on balance alone'
);

update public.organizations
   set free_credit_caps_lifted_at = null
 where id = '62000000-0000-0000-0000-000000000001';

select is(
  public.gateway_org_free_credit_funded('62000000-0000-0000-0000-000000000001'),
  true,
  'restoring the caps flips the predicate back'
);

-- ---------------------------------------------------------------------------
-- 7. A paid top-up permanently lifts the caps (launch rule).

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source, source_ref)
values ('62000000-0000-0000-0000-000000000001', 'topup', 25, 'pgTAP top-up',
        'stripe', 'cs_test_pgtap_bp');

select is(
  public.gateway_org_free_credit_funded('62000000-0000-0000-0000-000000000001'),
  false,
  'one topup ledger row ends free-credit funding'
);

select is(
  (select allowed from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000001', 'model-a', 60000000)),
  true,
  'a topped-up org is bounded by balance only, not the daily caps'
);

-- ---------------------------------------------------------------------------
-- 8. Balance gate precedence and copy (the gate itself stays pinned by the
--    runtime suite; this pins the refusal order and the verbose copy).

select is(
  (select reason_code from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000002', 'model-a', 60000000)),
  'insufficient_credits',
  'an exhausted balance refuses before any cap is considered'
);

select alike(
  (select message from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000002', 'model-a', 1)),
  '%out of platform credits (balance: $0.00). Add credits at https://platform.experientiallabs.ai/credits — top-ups start at $5. Requests using your own provider keys (BYOK) are unaffected.%',
  'the out-of-credits copy is BC-P6''s verbatim text with the printed balance'
);

update public.organizations
   set billable_spend_usd = credit_granted_usd + 0.43
 where id = '62000000-0000-0000-0000-000000000002';

select alike(
  (select message from public.gateway_spend_policy_check(
    '62000000-0000-0000-0000-000000000002', 'model-a', 1)),
  '%(balance: $-0.43)%',
  'a negative balance is printed honestly, never clamped'
);

select is(
  (select reason_code from public.gateway_spend_policy_check(
    '00000000-0000-0000-0000-00000000dead', 'model-a', 1)),
  'insufficient_credits',
  'a missing organization is refused with the org scope'
);

-- ---------------------------------------------------------------------------
-- 9. Settlement: exact debit, spend_usd untouched, unknown-cost counter.

insert into bp_vals
select 'billable_before', billable_spend_usd::text
  from public.organizations
 where id = '62000000-0000-0000-0000-000000000001';

insert into bp_vals
select 'spend_before', spend_usd::text
  from public.organizations
 where id = '62000000-0000-0000-0000-000000000001';

-- An unknown-cost attempt: output was delivered but no cost was computable,
-- so the caller settles it at 0 and the seam flags it for review.
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, output_tokens, estimated_cost_micro_usd,
  budget_period_start, budget_reserved_micro_usd, budget_settled_micro_usd
) values
  ('bp-a-unknown', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 5, 0,
   'dep-1', 'prov-openai', 'model-u', 'pool-1', repeat('cd', 32),
   'host_managed', 'completed', now(), now(), 100, null,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   0, 0),
  ('bp-a-insured', 'bp-r-fix', '62000000-0000-0000-0000-000000000001', 6, 0,
   'dep-1', 'prov-openai', 'model-u', 'pool-1', repeat('cd', 32),
   'host_managed', 'failed', now(), now(), 0, null,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   0, 0);

select public.gateway_settle_billing(
  '62000000-0000-0000-0000-000000000001', 'bp-r-fix', 'bp-a-unknown', 0);

select is(
  (select gateway_unknown_cost_attempts from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  1::bigint,
  'an unknown-cost attempt with delivered output increments the review counter'
);

select public.gateway_settle_billing(
  '62000000-0000-0000-0000-000000000001', 'bp-r-fix', 'bp-a-insured', 0);

select is(
  (select gateway_unknown_cost_attempts from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  1::bigint,
  'zero-completion insurance is not an unknown-cost review case'
);

select is(
  (select billable_spend_usd::text from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  (select v from bp_vals where k = 'billable_before'),
  'zero-amount settlements never touch billable spend'
);

select public.gateway_settle_billing(
  '62000000-0000-0000-0000-000000000001', 'bp-r-fix', 'bp-a-today-a', 7000);

select is(
  (select billable_spend_usd from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  (select v from bp_vals where k = 'billable_before')::numeric + 0.007,
  'a settled amount debits billable spend at exactly micro-USD precision'
);

select is(
  (select spend_usd::text from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  (select v from bp_vals where k = 'spend_before'),
  'gateway settlement never bumps spend_usd (recompute_org_spend cannot see gateway rows)'
);

select throws_ok(
  $$select public.gateway_settle_billing(
    '62000000-0000-0000-0000-000000000001', 'bp-r-fix', 'bp-a-missing', 5)$$,
  'P0002',
  null,
  'settling a nonexistent attempt fails loudly'
);

select throws_ok(
  $$select public.gateway_settle_billing(
    '62000000-0000-0000-0000-000000000001', 'bp-r-fix', 'bp-a-today-a', -1)$$,
  '22023',
  null,
  'a negative settlement amount is refused'
);

-- ---------------------------------------------------------------------------
-- 10. No double-debit on replay, through the real settlement path.

select public.gateway_accept_request(
  'bp-r-real', '62000000-0000-0000-0000-000000000001',
  '62000000-0000-0000-0000-000000000011', 'gpt-test', 'rev-x',
  'chat_completions', encode(sha256('bp-real'::bytea), 'hex'),
  null, now() + interval '1 hour'
);

insert into bp_vals
select 'a_real', s.attempt_id from public.gateway_start_attempt(
  'bp-r-real', '62000000-0000-0000-0000-000000000001', 0, 0,
  'dep-1', 'prov-openai', 'model-a', 'pool-1', repeat('cd', 32),
  'host_managed', 'launch_catalog', now(),
  2000000, null, 10000000, null, 1000000
) s;

insert into bp_vals
select 'billable_pre_real', billable_spend_usd::text
  from public.organizations
 where id = '62000000-0000-0000-0000-000000000001';

select public.gateway_settle_attempt(
  (select v from bp_vals where k = 'a_real'), 'completed', null,
  1000, 0, 500, 0, 'observed', true
);

select is(
  (select billable_spend_usd from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  (select v from bp_vals where k = 'billable_pre_real')::numeric + 0.007,
  'the real settlement path debits the settled cost once'
);

select lives_ok(
  $$select public.gateway_settle_attempt(
    (select v from bp_vals where k = 'a_real'), 'completed', null,
    1000, 0, 500, 0, 'observed', true
  )$$,
  'replaying the settlement is a no-op receipt'
);

select is(
  (select billable_spend_usd from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  (select v from bp_vals where k = 'billable_pre_real')::numeric + 0.007,
  'a replayed settlement never double-debits'
);

select is(
  (select gateway_unknown_cost_attempts from public.organizations
   where id = '62000000-0000-0000-0000-000000000001'),
  1::bigint,
  'a replayed settlement never re-counts unknown-cost attempts'
);

select * from finish();

rollback;
