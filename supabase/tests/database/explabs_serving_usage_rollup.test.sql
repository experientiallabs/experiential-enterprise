begin;

create extension if not exists pgtap with schema extensions;

select plan(8);

insert into public.organizations (id, slug, name)
values ('80000000-0000-0000-0000-000000000001', 'pgtap-rollup-tenant', 'pgTAP Rollup Tenant');

-- Two endpoints: one with priced + unpriced traffic, one small; labels follow
-- the newest row like the other serving reads.
insert into public.serving_requests
  (id, org_id, endpoint_id, endpoint_label, cost_usd, created_at)
values
  ('80000000-0000-0000-0000-000000000010', '80000000-0000-0000-0000-000000000001',
   '80000000-0000-0000-0000-000000000002', 'support-old', 0.20, now() - interval '2 hours'),
  ('80000000-0000-0000-0000-000000000011', '80000000-0000-0000-0000-000000000001',
   '80000000-0000-0000-0000-000000000002', 'support-prod', null, now() - interval '1 hour'),
  ('80000000-0000-0000-0000-000000000012', '80000000-0000-0000-0000-000000000001',
   '80000000-0000-0000-0000-000000000003', 'internal-tools', 0.01, now());

select is(
  (select count(*)::int from public.serving_usage_rollup('80000000-0000-0000-0000-000000000001')),
  2,
  'one rollup row per endpoint'
);

select is(
  (select endpoint_label
     from public.serving_usage_rollup('80000000-0000-0000-0000-000000000001')
    limit 1),
  'support-prod',
  'highest spend first, label from the newest row'
);

select is(
  (select cost_usd
     from public.serving_usage_rollup('80000000-0000-0000-0000-000000000001')
    limit 1),
  0.20::numeric,
  'unpriced rows never sum as dollars'
);

select is(
  (select unpriced_count
     from public.serving_usage_rollup('80000000-0000-0000-0000-000000000001')
    limit 1),
  1::bigint,
  'unpriced rows are counted next to the priced total'
);

select is(
  (select count(*)::int
     from public.serving_usage_rollup('00000000-0000-0000-0000-00000000dead')),
  0,
  'a foreign org sees nothing'
);

select ok(
  not has_function_privilege('authenticated', 'public.serving_usage_rollup(uuid)', 'execute'),
  'rollup is service-role only, like every serving read'
);

-- The counter and the rollup cover the same traffic: the trigger metered the
-- priced inserts above, and the repair path folds the serving term.
select is(
  (select spend_usd from public.organizations
    where id = '80000000-0000-0000-0000-000000000001'),
  0.21::numeric,
  'the spend trigger meters priced serving rows (unpriced add nothing)'
);

update public.organizations
   set spend_usd = 999
 where id = '80000000-0000-0000-0000-000000000001';

select is(
  public.recompute_org_spend('80000000-0000-0000-0000-000000000001'),
  0.21::numeric,
  'recompute_org_spend folds the serving term'
);

select * from finish();

rollback;
