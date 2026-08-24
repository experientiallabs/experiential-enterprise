begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

-- Personal-org provisioning is gated by the signups_enabled kill switch;
-- pin it on so the signup path below exercises the promo grant.
update public.app_settings set signups_enabled = true;

-- ---------------------------------------------------------------------------
-- Signup promo: a new organization starts with a $20 grant, not a limit.

insert into public.organizations (id, slug, name)
values ('51000000-0000-0000-0000-000000000001', 'pgtap-credit-tenant', 'pgTAP Credit Tenant');

select is(
  (
    select credit_granted_usd
    from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  20.000000::numeric,
  'a newly created organization holds the $20 welcome grant on its counter'
);

select is(
  (
    select count(*)::int
    from public.credit_ledger
    where org_id = '51000000-0000-0000-0000-000000000001'
      and source = 'signup_promo'
  ),
  1,
  'the welcome grant is a ledger row, not a column default'
);

-- Signup-provisioned personal orgs get the same grant through the trigger.
insert into auth.users (id, email)
values ('51000000-0000-0000-0000-000000000002', 'credit.person@example.com');

select is(
  (
    select orgs.credit_granted_usd
    from public.organizations orgs
    join public.organization_members members on members.org_id = orgs.id
    where members.user_id = '51000000-0000-0000-0000-000000000002'
  ),
  20.000000::numeric,
  'a signup-provisioned personal org starts with the welcome grant'
);

-- ---------------------------------------------------------------------------
-- The ledger trigger maintains the counter for every entry type.

insert into public.credit_ledger (org_id, entry_type, amount_usd, reason, source)
values
  ('51000000-0000-0000-0000-000000000001', 'topup', 100, 'pgtap topup', 'stripe'),
  ('51000000-0000-0000-0000-000000000001', 'adjustment', -5, 'pgtap correction', 'admin');

select is(
  (
    select credit_granted_usd
    from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  115.000000::numeric,
  'grants, top-ups, and negative adjustments all move the granted counter'
);

-- Vocabulary is enforced at the table.
select throws_ok(
  $$insert into public.credit_ledger (org_id, entry_type, amount_usd, source)
    values ('51000000-0000-0000-0000-000000000001', 'grant', -10, 'admin')$$,
  '23514',
  null,
  'a negative grant violates the sign check (only adjustments may be negative)'
);

select throws_ok(
  $$insert into public.credit_ledger (org_id, entry_type, amount_usd, source)
    values ('51000000-0000-0000-0000-000000000001', 'grant', 0, 'admin')$$,
  '23514',
  null,
  'a zero entry is refused'
);

-- Replayed external credits cannot double-apply.
insert into public.credit_ledger (org_id, entry_type, amount_usd, source, source_ref)
values ('51000000-0000-0000-0000-000000000001', 'topup', 25, 'stripe', 'cs_test_pgtap_1');

select throws_ok(
  $$insert into public.credit_ledger (org_id, entry_type, amount_usd, source, source_ref)
    values ('51000000-0000-0000-0000-000000000001', 'topup', 25, 'stripe', 'cs_test_pgtap_1')$$,
  '23505',
  null,
  'a replayed source_ref (webhook retry) is refused by the unique index'
);

-- Append-only: no updates, no deletes while the org lives.
select throws_ok(
  $$update public.credit_ledger set amount_usd = 999
    where org_id = '51000000-0000-0000-0000-000000000001'$$,
  'P0001',
  null,
  'ledger rows cannot be updated'
);

select throws_ok(
  $$delete from public.credit_ledger
    where org_id = '51000000-0000-0000-0000-000000000001'$$,
  'P0001',
  null,
  'ledger rows cannot be deleted while their organization exists'
);

-- ---------------------------------------------------------------------------
-- Serving spend: platform-keyed rows draw down credits, BYOK rows do not.

insert into public.endpoints (id, org_id, name, policy)
values (
  '51000000-0000-0000-0000-00000000e001',
  '51000000-0000-0000-0000-000000000001',
  'pgtap-credit-endpoint',
  '{"kind": "static", "model": "gpt-5.5"}'::jsonb
)
on conflict (id) do nothing;

insert into public.serving_requests
  (id, org_id, endpoint_id, endpoint_label, input_tokens, output_tokens, cost_usd, status)
values
  ('51000000-0000-0000-0000-00000000a001', '51000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-00000000e001', 'pgtap-credit-endpoint', 100, 50, 2.5, 'ok');

select is(
  (
    select billable_spend_usd
    from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  2.500000::numeric,
  'a platform-keyed serving row moves the billable counter'
);

-- A BYOK row: metered in spend_usd, absent from billable_spend_usd, and
-- drawn down against the org connection it rode. The connection enters
-- through the real RPC (the only write path for credentials).
select lives_ok(
  $$select public.upsert_provider_connection(
      '51000000-0000-0000-0000-000000000001',
      'openai',
      '{}'::jsonb,
      'sk-pgtap-byok-key-000',
      null
  )$$,
  'the org connects its own OpenAI key'
);

update public.provider_connections
   set declared_balance_usd = 50, declared_balance_set_at = now()
 where org_id = '51000000-0000-0000-0000-000000000001'
   and provider = 'openai';

insert into public.serving_requests
  (id, org_id, endpoint_id, endpoint_label, input_tokens, output_tokens, cost_usd, status,
   byok, provider_connection_id)
select
  '51000000-0000-0000-0000-00000000a002', '51000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-00000000e001', 'pgtap-credit-endpoint', 200, 80, 4.0, 'ok',
  true, connections.id
from public.provider_connections connections
where connections.org_id = '51000000-0000-0000-0000-000000000001'
  and connections.provider = 'openai';

select is(
  (
    select spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  6.500000::numeric,
  'BYOK serving is metered in spend_usd like everything else'
);

select is(
  (
    select billable_spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  2.500000::numeric,
  'BYOK serving never draws down platform credits'
);

select is(
  (
    select metered_spend_usd from public.provider_connections
    where org_id = '51000000-0000-0000-0000-000000000001' and provider = 'openai'
  ),
  4.000000::numeric,
  'BYOK serving draws down the connection''s declared balance instead'
);

-- NaN cannot poison the granted counter (numeric admits it; `> 0` passes it).
select throws_ok(
  $$insert into public.credit_ledger (org_id, entry_type, amount_usd, source)
    values ('51000000-0000-0000-0000-000000000001', 'grant', 'NaN'::numeric, 'admin')$$,
  '23514',
  null,
  'a NaN amount is refused by the finite check'
);

-- Deleting the BYOK row reverses exactly what it applied, even though the
-- byok flag (not the nullable connection fk) is what the trigger reads.
delete from public.serving_requests
where id = '51000000-0000-0000-0000-00000000a002';

select is(
  (
    select spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  2.500000::numeric,
  'deleting a BYOK row reverses the spend meter without touching billable'
);

select is(
  (
    select metered_spend_usd from public.provider_connections
    where org_id = '51000000-0000-0000-0000-000000000001' and provider = 'openai'
  ),
  0.000000::numeric,
  'deleting a BYOK row hands the drawdown back to the connection'
);

-- ---------------------------------------------------------------------------
-- Deletes never refund billable: money stays spent when its rows are wiped.
-- (A platform-billed serving row this time; sessions/rollouts/builds share
-- the same meter-only DELETE leg.)

insert into public.serving_requests
  (id, org_id, endpoint_id, endpoint_label, input_tokens, output_tokens, cost_usd, status)
values
  ('51000000-0000-0000-0000-00000000a003', '51000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-00000000e001', 'pgtap-credit-endpoint', 50, 20, 1.5, 'ok');

delete from public.serving_requests
where id = '51000000-0000-0000-0000-00000000a003';

select is(
  (
    select spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  2.500000::numeric,
  'deleting a platform-billed row reverses the display meter'
);

select is(
  (
    select billable_spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  4.000000::numeric,
  'deleting a platform-billed row never refunds billable spend (no 402 reset by deletion)'
);

-- ---------------------------------------------------------------------------
-- Repair path recomputes the display meter and leaves billable alone
-- (surviving rows are a floor, not the truth, once deletes keep billable).

update public.organizations
   set spend_usd = 999
 where id = '51000000-0000-0000-0000-000000000001';

select public.recompute_org_spend('51000000-0000-0000-0000-000000000001');

select is(
  (
    select spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  2.500000::numeric,
  'recompute_org_spend rebuilds the display meter from surviving rows'
);

select is(
  (
    select billable_spend_usd from public.organizations
    where id = '51000000-0000-0000-0000-000000000001'
  ),
  4.000000::numeric,
  'recompute_org_spend never touches billable (repairs go through the ledger)'
);

select * from finish();

rollback;
