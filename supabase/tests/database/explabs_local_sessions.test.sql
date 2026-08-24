begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

insert into public.organizations (id, slug, name)
values ('b0000000-0000-0000-0000-000000000001', 'local-org', 'Local Org');

insert into public.organization_members (org_id, user_id, role)
values (
  'b0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000091',
  'user'
);

insert into public.local_pi_runs (
  id, org_id, worker_provider, worker_model
)
values (
  'b0000000-0000-0000-0000-000000000051',
  'b0000000-0000-0000-0000-000000000001',
  'bedrock',
  'claude-haiku-4-5'
);

select public.increment_local_pi_run_usage(
  'b0000000-0000-0000-0000-000000000051', 40, 10, 0.001
);

select is(
  (select llm_calls from public.local_pi_runs
   where id = 'b0000000-0000-0000-0000-000000000051'),
  1,
  'the built-in pi proxy counts worker calls'
);

select is(
  (select cost_usd from public.local_pi_runs
   where id = 'b0000000-0000-0000-0000-000000000051'),
  0.001::numeric,
  'the built-in pi proxy records priced worker spend'
);

select is(
  (select spend_usd from public.organizations
   where id = 'b0000000-0000-0000-0000-000000000001'),
  0.001::numeric,
  'org spend includes built-in pi worker calls'
);

update public.organizations set spend_usd = 0
where id = 'b0000000-0000-0000-0000-000000000001';

select is(
  public.recompute_org_spend('b0000000-0000-0000-0000-000000000001'),
  0.001::numeric,
  'spend repair includes built-in pi execution'
);

select is(
  (select status from public.finish_local_pi_run(
    'b0000000-0000-0000-0000-000000000051',
    'ended', 'user_ended', null
  )),
  'ended',
  'the built-in pi run reaches a terminal state'
);

select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-000000000091', true);
set local role authenticated;

select is(
  (select count(*)::int from public.local_pi_runs),
  1,
  'an org member can read their built-in pi usage rows'
);

select * from finish();
rollback;
