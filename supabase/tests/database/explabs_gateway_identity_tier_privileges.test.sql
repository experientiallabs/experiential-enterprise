begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- Deny-by-default posture for the identity tier's management tables. These
-- three tables decide gateway ACCESS and SPEND, so browser-facing roles get
-- no path to them at all: RLS is on with zero policies and no grants, and
-- only service_role (the control API) holds DML. The identity-tier suite
-- proves the cutover semantics; this suite pins the privilege shape.

set local role authenticated;

select throws_ok(
  $$select count(*) from public.gateway_identities$$,
  '42501',
  null,
  'authenticated cannot read gateway_identities'
);

select throws_ok(
  $$select count(*) from public.gateway_grants$$,
  '42501',
  null,
  'authenticated cannot read gateway_grants'
);

select throws_ok(
  $$select count(*) from public.gateway_budgets$$,
  '42501',
  null,
  'authenticated cannot read gateway_budgets'
);

select throws_ok(
  $$insert into public.gateway_identities (identity_id, org_id, display_name)
    values ('idtp-rogue', '76000000-0000-0000-0000-000000000001', 'Rogue')$$,
  '42501',
  null,
  'authenticated cannot insert gateway_identities'
);

select throws_ok(
  $$insert into public.gateway_grants (org_id, identity_id, alias_id)
    values ('76000000-0000-0000-0000-000000000001', 'idtp-rogue', 'idtp-alias')$$,
  '42501',
  null,
  'authenticated cannot insert gateway_grants'
);

select throws_ok(
  $$insert into public.gateway_budgets
      (budget_id, org_id, period, scope_kind, limit_micro_usd)
    values ('idtp-budget', '76000000-0000-0000-0000-000000000001',
            '2026-08', 'team', 1000000)$$,
  '42501',
  null,
  'authenticated cannot insert gateway_budgets'
);

reset role;

select ok(
  not has_table_privilege('anon', 'public.gateway_identities', 'select'),
  'anon has no read on gateway_identities'
);

select ok(
  not has_table_privilege('anon', 'public.gateway_grants', 'select'),
  'anon has no read on gateway_grants'
);

select ok(
  not has_table_privilege('anon', 'public.gateway_budgets', 'select'),
  'anon has no read on gateway_budgets'
);

select ok(
  has_table_privilege('service_role', 'public.gateway_identities', 'insert'),
  'the control API writes gateway_identities as service_role'
);

select ok(
  has_table_privilege('service_role', 'public.gateway_grants', 'insert'),
  'the control API writes gateway_grants as service_role'
);

select ok(
  has_table_privilege('service_role', 'public.gateway_budgets', 'insert'),
  'the control API writes gateway_budgets as service_role'
);

select * from finish();

rollback;
