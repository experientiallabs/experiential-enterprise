begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixture tenant: one org, world model, trace upload, and agent so every
-- metered surface has an attributable owner.
insert into public.organizations (id, slug, name)
values ('60000000-0000-0000-0000-000000000001', 'pgtap-spend-tenant', 'pgTAP Spend Tenant');

insert into public.world_models (id, org_id, name, display_name, status)
values (
  '60000000-0000-0000-0000-000000000003',
  '60000000-0000-0000-0000-000000000001',
  'pgtap-spend-model',
  'pgTAP Spend Model',
  'ready'
);

insert into public.trace_uploads (id, org_id, world_model_id, filename, storage_path)
values (
  '60000000-0000-0000-0000-000000000004',
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000003',
  'pgtap-spend.otel.jsonl',
  'traces/pgtap/pgtap-spend.jsonl'
);

insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  '60000000-0000-0000-0000-000000000005',
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000003',
  'pgtap-spend-agent',
  'bedrock',
  'glm-5'
);

create function pg_temp.org_spend() returns numeric language sql as $$
  select spend_usd from public.organizations
  where id = '60000000-0000-0000-0000-000000000001';
$$;

select is(pg_temp.org_spend(), 0::numeric, 'a fresh org starts at zero spend');

-- Sessions: inserts and cost updates move the counter; null cost adds nothing.
insert into public.wm_sessions (id, org_id, world_model_id, cost_usd)
values (
  '60000000-0000-0000-0000-000000000010',
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000003',
  null
);

select is(pg_temp.org_spend(), 0::numeric, 'an unpriced session adds nothing');

update public.wm_sessions
   set cost_usd = 2.5
 where id = '60000000-0000-0000-0000-000000000010';

select is(pg_temp.org_spend(), 2.5::numeric, 'pricing a session moves the counter');

update public.wm_sessions
   set cost_usd = 4.0
 where id = '60000000-0000-0000-0000-000000000010';

select is(pg_temp.org_spend(), 4.0::numeric, 'a cost update applies the delta, not the sum');

-- Rollouts: both legs count.
insert into public.wm_rollouts
  (id, org_id, world_model_id, agent_provider, agent_model, task, max_steps, cost_usd, wm_cost_usd)
values (
  '60000000-0000-0000-0000-000000000011',
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000003',
  'bedrock',
  'glm-5',
  'pgtap task',
  4,
  1.0,
  0.5
);

select is(pg_temp.org_spend(), 5.5::numeric, 'both rollout legs count toward the counter');

-- Builds: the tracker's positive total is priced spend...
insert into public.build_jobs (id, world_model_id, trace_upload_id, usage)
values (
  '60000000-0000-0000-0000-000000000012',
  '60000000-0000-0000-0000-000000000003',
  '60000000-0000-0000-0000-000000000004',
  '{"total": {"cost_usd": 3.0}}'::jsonb
);

select is(pg_temp.org_spend(), 8.5::numeric, 'a priced build total counts');

-- ...and its zero total is the unpriced-model sentinel, never spend.
insert into public.build_jobs (id, world_model_id, trace_upload_id, usage)
values (
  '60000000-0000-0000-0000-000000000013',
  '60000000-0000-0000-0000-000000000003',
  '60000000-0000-0000-0000-000000000004',
  '{"total": {"cost_usd": 0.0}}'::jsonb
);

select is(pg_temp.org_spend(), 8.5::numeric, 'a zero build total is the unpriced sentinel');

-- Optimization runs: every model and E2B leg sums; null legs add nothing.
insert into public.agent_opt_runs (id, agent_id, iterations, k, usage)
values (
  '60000000-0000-0000-0000-000000000014',
  '60000000-0000-0000-0000-000000000005',
  2,
  2,
  '{"worker": {"cost_usd": 1.0}, "judge": {"cost_usd": 0.25}, "world_model": {"cost_usd": null}, "meta": {"cost_usd": 0.4}, "sandbox": {"cost_usd": 0.5}, "meta_sandbox": {"cost_usd": 0.1}}'::jsonb
);

select is(pg_temp.org_spend(), 10.75::numeric, 'all optimization legs sum into the counter');

-- Optimization rollout spend is historical world-model usage. Deleting its
-- parent run clears provenance but must not refund the already-incurred bill.
insert into public.wm_rollouts
  (id, org_id, world_model_id, agent_provider, agent_model, task, max_steps, is_optimization, agent_opt_run_id, cost_usd, wm_cost_usd)
values (
  '60000000-0000-0000-0000-000000000015',
  '60000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000003',
  'bedrock',
  'glm-5',
  'optimizer episode',
  4,
  true,
  '60000000-0000-0000-0000-000000000014',
  0.0,
  0.75
);

select is(pg_temp.org_spend(), 11.5::numeric, 'optimizer rollout bills world-model usage');

insert into public.wm_rollout_turns (rollout_id, turn_index, role, content)
values (
  '60000000-0000-0000-0000-000000000015',
  0,
  'env',
  '{"content": "historical simulator output"}'::jsonb
);

delete from public.agent_opt_runs where id = '60000000-0000-0000-0000-000000000014';

select is(
  (select agent_opt_run_id from public.wm_rollouts where id = '60000000-0000-0000-0000-000000000015'),
  null,
  'deleting an optimization run clears rollout provenance without deleting history'
);
select is(
  (select is_optimization from public.wm_rollouts where id = '60000000-0000-0000-0000-000000000015'),
  true,
  'deleting an optimization run preserves the durable internal-episode marker'
);
select is(pg_temp.org_spend(), 9.25::numeric, 'run deletion preserves incurred rollout spend');

-- Deletes subtract, mirroring the scan-based rollup.
delete from public.wm_rollouts where id = '60000000-0000-0000-0000-000000000011';

select is(pg_temp.org_spend(), 7.75::numeric, 'deleting a rollout subtracts its spend');

-- The repair function recomputes the same figure from the metered tables.
select is(
  public.recompute_org_spend('60000000-0000-0000-0000-000000000001'),
  7.75::numeric,
  'recompute_org_spend agrees with the trigger-maintained counter'
);

-- Drift repair: recompute overwrites a corrupted counter.
update public.organizations
   set spend_usd = 999
 where id = '60000000-0000-0000-0000-000000000001';

select is(
  public.recompute_org_spend('60000000-0000-0000-0000-000000000001'),
  7.75::numeric,
  'recompute_org_spend repairs a drifted counter'
);

select is(pg_temp.org_spend(), 7.75::numeric, 'the repaired counter is persisted');

-- Deleting the world model removes live serving/build/playground state, but
-- historical optimization episodes and their incurred spend remain.
delete from public.world_models where id = '60000000-0000-0000-0000-000000000003';

select is(pg_temp.org_spend(), 0.75::numeric, 'a world-model delete preserves historical optimization spend');
select is(
  (select world_model_id from public.wm_rollouts where id = '60000000-0000-0000-0000-000000000015'),
  null,
  'a world-model delete clears only the retained optimization provenance pointer'
);
select is(
  (select count(*)::int from public.wm_rollout_turns where rollout_id = '60000000-0000-0000-0000-000000000015'),
  1,
  'a world-model delete preserves the optimization transcript'
);

select * from finish();

rollback;
