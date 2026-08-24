begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

insert into public.organizations (id, slug, name)
values ('d0000000-0000-0000-0000-000000000001', 'pgtap-audit-tenant', 'pgTAP Audit Tenant');

-- Two rows: one written the way every pre-audit row was (nothing about the
-- decision), one carrying the full RequestLogRecord contract.
insert into public.serving_requests
  (id, org_id, endpoint_id, endpoint_label)
values
  ('d0000000-0000-0000-0000-000000000010', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'support-prod');

insert into public.serving_requests
  (id, org_id, endpoint_id, endpoint_label, model, cluster_id, cluster_label,
   routing_reason, provider_model, router_cost_usd, leg, cost_usd)
values
  ('d0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'support-prod',
   'claude-haiku-4-5', '3', 'billing-questions',
   'cluster 3 (billing-questions) routes to the cheapest model above the quality floor',
   'us.anthropic.claude-haiku-4-5-v1:0', 0, 'serving', 0.000164);

select is(
  (select leg from public.serving_requests
    where id = 'd0000000-0000-0000-0000-000000000010'),
  'serving',
  'a row written without a leg is customer serving traffic'
);

select is(
  (select routing_reason from public.serving_requests
    where id = 'd0000000-0000-0000-0000-000000000010'),
  null,
  'a row predating these columns reports no decision rather than a made-up one'
);

select is(
  (select routing_reason from public.serving_requests
    where id = 'd0000000-0000-0000-0000-000000000011'),
  'cluster 3 (billing-questions) routes to the cheapest model above the quality floor',
  'the reason the policy gave is stored verbatim'
);

select is(
  (select provider_model from public.serving_requests
    where id = 'd0000000-0000-0000-0000-000000000011'),
  'us.anthropic.claude-haiku-4-5-v1:0',
  'the provider runtime id behind the pool entry is recorded'
);

-- Zero is a measurement, not an absence: evaluating the free hashing policy
-- costs nothing, and the check must let that through beside the null case.
select is(
  (select router_cost_usd from public.serving_requests
    where id = 'd0000000-0000-0000-0000-000000000011'),
  0::numeric,
  'a free routing policy stores a real zero, not a null'
);

select throws_like(
  $$insert into public.serving_requests
      (org_id, endpoint_id, endpoint_label, router_cost_usd)
    values ('d0000000-0000-0000-0000-000000000001',
            'd0000000-0000-0000-0000-000000000002', 'support-prod', -0.01)$$,
  '%serving_requests_router_cost_usd_check%',
  'a negative router cost is rejected'
);

select throws_like(
  $$insert into public.serving_requests
      (org_id, endpoint_id, endpoint_label, leg)
    values ('d0000000-0000-0000-0000-000000000001',
            'd0000000-0000-0000-0000-000000000002', 'support-prod', 'training')$$,
  '%serving_requests_leg_check%',
  'the D-METERING leg vocabulary is closed'
);

select throws_like(
  $$insert into public.serving_requests
      (org_id, endpoint_id, endpoint_label, leg)
    values ('d0000000-0000-0000-0000-000000000001',
            'd0000000-0000-0000-0000-000000000002', 'support-prod', null)$$,
  '%null value in column "leg"%',
  'every metered call belongs to a leg'
);

-- The audit columns exist for operators, and the customer-facing read path
-- must not grow them by accident: the list RPC's declared result is the
-- contract the Telemetry page reads, so assert the mechanism never appears in
-- it. The per-row detail view's stripping is asserted on the API side.
select doesnt_match(
  pg_get_function_result(
    'public.list_serving_requests(uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,uuid,integer)'::regprocedure
  ),
  '\y(routing_reason|provider_model|router_cost_usd|leg|model|cluster_id|cluster_label)\y',
  'the customer list RPC returns no mechanism column'
);

-- The columns land on a table no REST role can read a row from. Asserted
-- through RLS rather than the table grant: the local stack's bootstrap
-- re-grants SELECT on every public table after migrations, so a grant
-- assertion would pass on a preview branch and fail locally while the actual
-- guarantee (RLS on, zero policies, so every anon/authenticated read returns
-- nothing) holds in both.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.serving_requests'::regclass)
    and not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'serving_requests'
    ),
  'the audit columns land on an RLS-locked table with no policies'
);

-- numeric, not float: per-call router costs are summed across a window, and
-- binary floating point would drift the total off the priced rows.
select col_type_is(
  'public', 'serving_requests', 'router_cost_usd', 'numeric',
  'the router cost is exact, like every other money column'
);

select * from finish();

rollback;
