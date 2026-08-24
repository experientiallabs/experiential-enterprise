begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Cost controls: SPEND ALERTS (migration 20260822140000). Rules are soft
-- thresholds (org monthly spend, or fraction of a budget consumed) that fire
-- at most once per rule per UTC month. gateway_spend_alerts_due() CLAIMS by
-- inserting the (alert, period) event row and returns every undelivered
-- claim; gateway_spend_alert_mark() retires (or records a failed) delivery.
-- Measurement reuses gateway_budget_scope_spent, so an alert can never
-- disagree with the gate it warns about.

-- ---------------------------------------------------------------------------
-- Fixtures: one org with $30 settled host-lane spend this month and a $20
-- budget on its identity ($30 > 80% of ... no: fraction budget uses its own
-- $40 budget below), plus rules on both sides of their thresholds.

insert into public.organizations (id, slug, name) values
  ('66000000-0000-0000-0000-000000000001', 'pgtap-alerts-tenant', 'pgTAP Alerts');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by) values
  ('66000000-0000-0000-0000-000000000011', '66000000-0000-0000-0000-000000000001',
   'k-alerts', 'xpl_al1', encode(sha256('al-k1'::bytea), 'hex'), null);

insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values
  ('al-r-1', '66000000-0000-0000-0000-000000000001',
   '66000000-0000-0000-0000-000000000011', 'alerts', 'rev-none',
   'chat_completions', encode(sha256('al-1'::bytea), 'hex'),
   now(), now() + interval '1 hour');

insert into public.gateway_attempts (
  attempt_id, request_id, org_id, api_key_id, attempt_ordinal, route_depth,
  deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
  billing_source, state, started_at, terminal_at, output_tokens,
  budget_period_start, budget_reserved_micro_usd, budget_settled_micro_usd
) values
  ('al-a-1', 'al-r-1', '66000000-0000-0000-0000-000000000001',
   '66000000-0000-0000-0000-000000000011', 0, 0,
   'dep-al', 'prov', 'm-al', 'pool-al', repeat('aa', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '10 minutes',
   100, (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   30000000, 30000000);

-- A key-scope budget of $40, 60% consumed ($24 <= $30 spent... $30/$40 = 75%).
insert into public.gateway_budgets
  (budget_id, org_id, period, scope_kind, api_key_id, identity_id, alias_id,
   pool_id, deployment_id, limit_micro_usd)
values
  ('al-bud-key', '66000000-0000-0000-0000-000000000001', '*', 'key',
   '66000000-0000-0000-0000-000000000011', null, null, null, null, 40000000),
  ('al-bud-old', '66000000-0000-0000-0000-000000000001', '2020-01', 'team',
   null, null, null, null, null, 1000000);

insert into public.gateway_spend_alerts
  (alert_id, org_id, kind, threshold_micro_usd, budget_id, threshold_fraction,
   notify_email)
values
  -- $25 threshold: crossed by the $30 settled spend.
  ('al-org-hit', '66000000-0000-0000-0000-000000000001', 'org_monthly_spend',
   25000000, null, null, 'ops@example.com'),
  -- $200 threshold: not crossed.
  ('al-org-miss', '66000000-0000-0000-0000-000000000001', 'org_monthly_spend',
   200000000, null, null, 'ops@example.com'),
  -- 70% of the $40 recurring key budget = $28: crossed ($30 spent).
  ('al-frac-hit', '66000000-0000-0000-0000-000000000001', 'budget_fraction',
   null, 'al-bud-key', 0.7, 'ops@example.com'),
  -- 90% of $40 = $36: not crossed.
  ('al-frac-miss', '66000000-0000-0000-0000-000000000001', 'budget_fraction',
   null, 'al-bud-key', 0.9, 'ops@example.com'),
  -- A fraction rule on a budget pinned to a PAST month: governs nothing now,
  -- must be skipped rather than measured.
  ('al-frac-old', '66000000-0000-0000-0000-000000000001', 'budget_fraction',
   null, 'al-bud-old', 0.5, 'ops@example.com');

-- ---------------------------------------------------------------------------
-- 1-4. First tick: exactly the two crossed rules claim, lease, and return.
-- The tick's rows are captured once -- the lease means a re-call deliberately
-- returns nothing (pinned in 6).

create temp table due_rows as select * from public.gateway_spend_alerts_due();

select is(
  (select pg_catalog.count(*) from due_rows
    where org_id = '66000000-0000-0000-0000-000000000001'),
  2::pg_catalog.int8,
  'the tick claims exactly the crossed rules (org threshold + budget fraction)'
);

select is(
  (select measured_micro_usd from due_rows where alert_id = 'al-org-hit'),
  30000000::pg_catalog.int8,
  'the org rule measures the charged-or-reserved month spend the gates use'
);

select is(
  (select threshold_micro_usd from due_rows where alert_id = 'al-frac-hit'),
  28000000::pg_catalog.int8,
  'the fraction rule materializes its threshold from the budget limit (70% of $40)'
);

select is(
  (select notify_email from due_rows where alert_id = 'al-org-hit'),
  'ops@example.com',
  'the claim carries the delivery context the email needs'
);

-- ---------------------------------------------------------------------------
-- 5-6. Once per month, once per sender: re-ticking neither duplicates the
--      event row nor hands the leased claims to a second concurrent sender.

select is(
  (select pg_catalog.count(*) from public.gateway_spend_alert_events
    where alert_id in ('al-org-hit', 'al-frac-hit')),
  2::pg_catalog.int8,
  'one event row per crossed rule per month, however many ticks ran'
);

select is(
  (select pg_catalog.count(*) from public.gateway_spend_alerts_due()
    where org_id = '66000000-0000-0000-0000-000000000001'),
  0::pg_catalog.int8,
  'an overlapping tick gets nothing while the delivery lease holds (no double email)'
);

-- ---------------------------------------------------------------------------
-- 7-9. Delivery receipts: success retires the claim; failure records the
--      error and clears the lease so the next tick retries immediately; a
--      crashed sender's expired lease self-heals.

select public.gateway_spend_alert_mark(
  'al-org-hit', to_char(now() at time zone 'UTC', 'YYYY-MM'), null);
select public.gateway_spend_alert_mark(
  'al-frac-hit', to_char(now() at time zone 'UTC', 'YYYY-MM'), 'smtp exploded');

select is(
  (select pg_catalog.array_agg(alert_id) from public.gateway_spend_alerts_due()
    where org_id = '66000000-0000-0000-0000-000000000001'),
  array['al-frac-hit'],
  'a failed delivery retries on the next tick; a successful one is retired'
);

select is(
  (select delivery_error from public.gateway_spend_alert_events
    where alert_id = 'al-frac-hit'),
  'smtp exploded',
  'a failed delivery records its error on the claim'
);

-- The retry tick above re-leased al-frac-hit; expire that lease as a crashed
-- sender would and the claim resurfaces on its own.
update public.gateway_spend_alert_events
   set claim_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
 where alert_id = 'al-frac-hit';

select is(
  (select pg_catalog.count(*) from public.gateway_spend_alerts_due()
    where alert_id = 'al-frac-hit'),
  1::pg_catalog.int8,
  'an expired delivery lease self-heals (a crashed sender never wedges a claim)'
);

-- ---------------------------------------------------------------------------
-- 10. The past-month budget rule never fired.

select is(
  (select pg_catalog.count(*) from public.gateway_spend_alert_events
    where alert_id in ('al-frac-old', 'al-org-miss', 'al-frac-miss')),
  0::pg_catalog.int8,
  'uncrossed rules and rules on non-governing budgets never claim'
);

-- ---------------------------------------------------------------------------
-- 11-12. Grants: the management API reaches rules and the read seam as
--        service_role; events stay RPC-written.

select ok(
  has_function_privilege(
    'service_role', 'public.gateway_spend_alerts_due()', 'execute'),
  'service_role can execute the claim seam'
);

select ok(
  not has_table_privilege(
    'service_role', 'public.gateway_spend_alert_events', 'insert'),
  'the event ledger is written only through the definer RPCs'
);

select * from finish();

rollback;
