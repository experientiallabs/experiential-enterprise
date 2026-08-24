begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

-- gw-identity P-D: the budgets READ seam, gateway_budget_balances (migration
-- 20260820110000). It returns one row per budget scope for an org+month with
-- its limit and its split reserved (dispatched) / settled (terminal)
-- host_managed spend, using the SAME scope resolution as the P-C enforcement
-- helper so the meter can never disagree with the reservation gate. The gate
-- and the combined spend are pinned by explabs_gateway_budget_enforcement; this
-- suite pins the reserved/settled split, month windowing, and scope resolution.

-- ---------------------------------------------------------------------------
-- Fixtures. Org M is metered; org N has no budgets (empty-read proof).

insert into public.organizations (id, slug, name) values
  ('64000000-0000-0000-0000-000000000001', 'pgtap-pd-tenant-m', 'pgTAP Balances M'),
  ('64000000-0000-0000-0000-000000000002', 'pgtap-pd-tenant-n', 'pgTAP Balances N');

-- The new-org trigger (20260820095000) already seeds the default identity on
-- the org insert above; on conflict keeps the named principal composing with it.
insert into public.gateway_identities (identity_id, org_id, display_name) values
  ('org-64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000001', 'Default'),
  ('meter', '64000000-0000-0000-0000-000000000001', 'Meter')
on conflict (identity_id) do nothing;

insert into public.api_keys (id, org_id, name, key_prefix, key_hash, created_by, identity_id) values
  ('64000000-0000-0000-0000-000000000011', '64000000-0000-0000-0000-000000000001',
   'k-meter', 'xpl_pdm', encode(sha256('pd-km'::bytea), 'hex'), null, 'meter');

insert into public.gateway_catalog_snapshots (catalog_sha256, document, models_document)
  values (repeat('ba', 32), '{}'::jsonb, '{}'::jsonb);
insert into public.gateway_aliases (alias_id, alias_name, org_id, active, origin)
  values ('alias-bal', 'balances', '64000000-0000-0000-0000-000000000001', true, 'named');
insert into public.gateway_alias_revisions (
  revision_id, alias_id, target, catalog_sha256, provider_connection_revisions
) values (
  'rev-bal', 'alias-bal', '{"pool_id":"pool-bal"}'::jsonb, repeat('ba', 32), '{}'::jsonb
);

-- Carrier requests keyed to the meter identity's key (identity attribution is
-- resolved request -> api_keys.identity_id).
insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at
) values
  ('pd-r-1', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'balances', 'rev-bal',
   'chat_completions', encode(sha256('pd-1'::bytea), 'hex'),
   now(), now() + interval '1 hour'),
  ('pd-r-2', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'balances', 'rev-bal',
   'chat_completions', encode(sha256('pd-2'::bytea), 'hex'),
   now(), now() + interval '1 hour'),
  ('pd-r-3', '64000000-0000-0000-0000-000000000001',
   '64000000-0000-0000-0000-000000000011', 'balances', 'rev-bal',
   'chat_completions', encode(sha256('pd-3'::bytea), 'hex'),
   now(), now() + interval '1 hour');

-- Spend this UTC month: one DISPATCHED attempt reserving $2 (terminal_at null,
-- settled null), one COMPLETED attempt settled at $3, and one PRIOR-month
-- completed $9 that must never count in this month's window.
insert into public.gateway_attempts (
  attempt_id, request_id, org_id, attempt_ordinal, route_depth, deployment_id,
  provider, exact_model_id, pool_id, catalog_sha256, billing_source, state,
  started_at, terminal_at, budget_period_start,
  budget_reserved_micro_usd, budget_settled_micro_usd
) values
  ('pd-a-reserved', 'pd-r-1', '64000000-0000-0000-0000-000000000001', 0, 0,
   'dep-bal', 'prov', 'm-r', 'pool-bal', repeat('ba', 32), 'host_managed',
   'dispatched', now() - interval '5 minutes', null,
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   2000000, null),
  ('pd-a-settled', 'pd-r-2', '64000000-0000-0000-0000-000000000001', 0, 0,
   'dep-bal', 'prov', 'm-s', 'pool-bal', repeat('ba', 32), 'host_managed',
   'completed', now() - interval '10 minutes', now() - interval '9 minutes',
   (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'),
   3000000, 3000000),
  ('pd-a-prior', 'pd-r-3', '64000000-0000-0000-0000-000000000001', 0, 0,
   'dep-bal', 'prov', 'm-p', 'pool-bal', repeat('ba', 32), 'host_managed',
   'completed', now() - interval '40 days', now() - interval '40 days',
   ((date_trunc('month', now() at time zone 'UTC') - interval '1 day') at time zone 'UTC'),
   9000000, 9000000);

-- Mimic the 20260822110000 backfill for the directly-seeded attempts above so
-- the key scope's denormalized read sees them (live dispatches stamp it).
update public.gateway_attempts attempts
   set api_key_id = requests.api_key_id
  from public.gateway_requests requests
 where requests.request_id = attempts.request_id
   and attempts.api_key_id is null;

insert into public.gateway_budgets
  (budget_id, org_id, period, scope_kind, api_key_id, identity_id, alias_id,
   pool_id, deployment_id, limit_micro_usd)
values
  ('bal-team', '64000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'team',
   null, null, null, null, null, 100000000),
  ('bal-identity', '64000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'identity',
   null, 'meter', null, null, null, 10000000),
  ('bal-key', '64000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'key',
   '64000000-0000-0000-0000-000000000011', null, null, null, null, 6000000),
  ('bal-model', '64000000-0000-0000-0000-000000000001',
   to_char(now() at time zone 'UTC', 'YYYY-MM'), 'model',
   null, null, 'alias-bal', null, null, 20000000),
  -- Recurring: governs every month, metered over the requested month.
  ('bal-rec', '64000000-0000-0000-0000-000000000001',
   '*', 'team', null, null, null, null, null, 50000000),
  -- A budget for a PAST month, to prove the window excludes it from a
  -- current-month read.
  ('bal-old', '64000000-0000-0000-0000-000000000001',
   '2020-01', 'team', null, null, null, null, null, 500000);

-- ---------------------------------------------------------------------------
-- 1-2. Identity scope: reserved counts the dispatched attempt, settled counts
--      the terminal one; the prior-month attempt is excluded from both.

select is(
  (select reserved_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where scope_kind = 'identity' and identity_id = 'meter'),
  2000000::pg_catalog.int8,
  'identity balance: reserved = the dispatched attempt only'
);

select is(
  (select settled_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where scope_kind = 'identity' and identity_id = 'meter'),
  3000000::pg_catalog.int8,
  'identity balance: settled = the terminal attempt only (prior month excluded)'
);

-- ---------------------------------------------------------------------------
-- 3-4. Team scope sees the whole org: same split, since all this-month spend is
--      on the metered identity.

select is(
  (select reserved_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-team'),
  2000000::pg_catalog.int8,
  'team balance: reserved = every host_managed dispatched attempt this month'
);

select is(
  (select settled_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-team'),
  3000000::pg_catalog.int8,
  'team balance: settled = every host_managed terminal attempt this month'
);

-- ---------------------------------------------------------------------------
-- 5. The limit rides through unchanged (the caller derives remaining from it).

select is(
  (select limit_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where scope_kind = 'identity' and identity_id = 'meter'),
  10000000::pg_catalog.int8,
  'balance carries the stored limit for the caller to derive remaining'
);

-- ---------------------------------------------------------------------------
-- 6. Only the requested month is returned: the current read excludes the 2020
--    budget row.

select is(
  (select pg_catalog.count(*) from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))),
  5::pg_catalog.int8,
  'a month read returns that month''s budgets plus recurring rows, never 2020'
);

-- ---------------------------------------------------------------------------
-- 6b. Key, model, and recurring balances mirror the enforcement arms.

select is(
  (select reserved_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-key'),
  2000000::pg_catalog.int8,
  'key balance: reserved reads the attempt''s denormalized api_key_id'
);

select is(
  (select settled_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-key'),
  3000000::pg_catalog.int8,
  'key balance: settled counts the key''s terminal attempts (prior month excluded)'
);

select is(
  (select settled_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-model'),
  3000000::pg_catalog.int8,
  'model balance: the alias across every pool/deployment via the frozen revision'
);

select is(
  (select settled_micro_usd from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-rec'),
  3000000::pg_catalog.int8,
  'a recurring budget folds into the month read metered over that month''s window'
);

select is(
  (select period from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000001',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))
   where budget_id = 'bal-rec'),
  '*',
  'the balance row carries the budget''s own period key (''*'' for recurring)'
);

-- ---------------------------------------------------------------------------
-- 7. An org with no budgets reads empty (unlimited everywhere = no meters).

select is(
  (select pg_catalog.count(*) from public.gateway_budget_balances(
     '64000000-0000-0000-0000-000000000002',
     to_char(now() at time zone 'UTC', 'YYYY-MM'))),
  0::pg_catalog.int8,
  'an org with no budget rows has no balances (nothing capped)'
);

-- ---------------------------------------------------------------------------
-- 8. service_role may execute the read seam (the management API calls it over
--    rpc); the internal scope-spend helper stays ungranted.

select ok(
  has_function_privilege(
    'service_role',
    'public.gateway_budget_balances(pg_catalog.uuid, pg_catalog.text)',
    'execute'
  ),
  'service_role can execute the budgets read seam'
);

select finish();

rollback;
