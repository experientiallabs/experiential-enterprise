begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- Schema: the report table exists with its load-bearing columns.
select has_table('public', 'agent_cost_reports', 'agent_cost_reports table exists');

select has_column('public', 'agent_cost_reports', 'org_id',
  'reports denormalize their owning org');
select has_column('public', 'agent_cost_reports', 'models',
  'reports record the compared catalog models');
select has_column('public', 'agent_cost_reports', 'tasks',
  'reports snapshot their task suite');
select has_column('public', 'agent_cost_reports', 'usage',
  'reports carry per-model metered usage');
select has_column('public', 'agent_cost_reports', 'status',
  'reports carry a worker lifecycle status');
select has_column('public', 'agent_cost_reports', 'budget_exempt',
  'reports carry the admin budget exemption');

-- Fixture tenant: one org with a member, a world model, and an agent so a
-- report has an attributable owner. organization_members.user_id carries no
-- FK to auth.users, so membership seeds with a bare uuid (never insert into
-- auth.users here: the provision_signup_org trigger would fire).
insert into public.organizations (id, slug, name)
values ('61000000-0000-0000-0000-000000000001', 'pgtap-cost-report-tenant', 'pgTAP Cost Report Tenant');

insert into public.organization_members (org_id, user_id, role)
values (
  '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000099',
  'user'
);

insert into public.world_models (id, org_id, name, display_name, status)
values (
  '61000000-0000-0000-0000-000000000003',
  '61000000-0000-0000-0000-000000000001',
  'pgtap-cost-report-model',
  'pgTAP Cost Report Model',
  'ready'
);

insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  '61000000-0000-0000-0000-000000000005',
  '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000003',
  'pgtap-cost-report-agent',
  'bedrock',
  'glm-5'
);

create function pg_temp.org_spend() returns numeric language sql as $$
  select spend_usd from public.organizations
  where id = '61000000-0000-0000-0000-000000000001';
$$;

select is(pg_temp.org_spend(), 0::numeric, 'a fresh org starts at zero spend');

-- A queued report has no usage yet; null usage adds nothing.
insert into public.agent_cost_reports (id, agent_id, org_id, models, tasks, usage)
values (
  '61000000-0000-0000-0000-000000000010',
  '61000000-0000-0000-0000-000000000005',
  '61000000-0000-0000-0000-000000000001',
  '["model-a", "model-b"]'::jsonb,
  '[{"task_id": "t1", "instruction": "pgtap task", "gold": "done"}]'::jsonb,
  null
);

select is(pg_temp.org_spend(), 0::numeric, 'a report with null usage adds nothing');

-- The DB backstop for the API's check-then-act mutual-exclusion read: at
-- most one queued/claimed/running report per agent.
select throws_ok(
  $$
  insert into public.agent_cost_reports (agent_id, org_id, models, tasks)
  values (
    '61000000-0000-0000-0000-000000000005',
    '61000000-0000-0000-0000-000000000001',
    '["model-a"]'::jsonb,
    '[{"task_id": "t1", "instruction": "pgtap task", "gold": "done"}]'::jsonb
  )
  $$,
  '23505',
  null,
  'a second active report per agent violates the one-active partial index'
);

-- Cross-table exclusivity: while the queued report above holds the agent's
-- work lock, an ACTIVE optimization run insert is rejected by the shared
-- trigger (terminal inserts pass untouched, proven by the completed
-- fixtures below).
select throws_ok(
  $$
  insert into public.agent_opt_runs (agent_id, iterations, k)
  values ('61000000-0000-0000-0000-000000000005', 1, 1)
  $$,
  '23505',
  null,
  'an active run cannot start while a cost report is active'
);

-- ...and the reverse: an agent with an active optimization run refuses an
-- active cost report.
insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  '61000000-0000-0000-0000-000000000006',
  '61000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000003',
  'pgtap-cost-report-agent-two',
  'bedrock',
  'glm-5'
);

insert into public.agent_opt_runs (agent_id, iterations, k)
values ('61000000-0000-0000-0000-000000000006', 1, 1);

select throws_ok(
  $$
  insert into public.agent_cost_reports (agent_id, org_id, models, tasks)
  values (
    '61000000-0000-0000-0000-000000000006',
    '61000000-0000-0000-0000-000000000001',
    '["model-a"]'::jsonb,
    '[{"task_id": "t1", "instruction": "pgtap task", "gold": "done"}]'::jsonb
  )
  $$,
  '23505',
  null,
  'an active cost report cannot start while an optimization run is active'
);

-- Two-model usage on a COMPLETED report (final usage implies a finished
-- report; the queued fixture above still holds the one-active slot): every
-- priced leg sums; null cost legs contribute nothing.
-- 1.25 + 0.5 + 0.4 + 0.1 + 2.0 + 0.25 = 4.5.
insert into public.agent_cost_reports (id, agent_id, org_id, status, models, tasks, usage)
values (
  '61000000-0000-0000-0000-000000000011',
  '61000000-0000-0000-0000-000000000005',
  '61000000-0000-0000-0000-000000000001',
  'completed',
  '["model-a", "model-b"]'::jsonb,
  '[{"task_id": "t1", "instruction": "pgtap task", "gold": "done"}]'::jsonb,
  '{
     "model-a": {
       "worker": {"input_tokens": 100, "output_tokens": 50, "calls": 3, "cost_usd": 1.25},
       "judge": {"cost_usd": 0.5},
       "world_model": {"cost_usd": null},
       "meta": {"cost_usd": 0.4},
       "meta_sandbox": {"cost_usd": 0.1}
     },
     "model-b": {
       "worker": {"cost_usd": 2.0},
       "judge": {"cost_usd": null},
       "world_model": {"cost_usd": 0.25}
     }
   }'::jsonb
);

select is(pg_temp.org_spend(), 4.5::numeric, 'priced legs across both models sum into the counter');

-- Incremental usage rewrites apply the delta, never the sum: the counter
-- lands on the new total (6.3), not old + new (10.8).
update public.agent_cost_reports
   set usage = '{
     "model-a": {
       "worker": {"cost_usd": 1.5},
       "judge": {"cost_usd": 0.75},
       "world_model": {"cost_usd": 0.25},
       "meta": {"cost_usd": 0.6},
       "meta_sandbox": {"cost_usd": 0.2}
     },
     "model-b": {
       "worker": {"cost_usd": 2.0},
       "judge": {"cost_usd": 0.5},
       "world_model": {"cost_usd": 0.5}
     }
   }'::jsonb
 where id = '61000000-0000-0000-0000-000000000011';

select is(pg_temp.org_spend(), 6.3::numeric, 'a usage update applies the delta, not the sum');

-- RLS mirrors agents: org members read their org's reports.
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000099', true);
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.agent_cost_reports
    where id = '61000000-0000-0000-0000-000000000011'
  ),
  1,
  'org member reads the org cost report'
);

-- No insert policy exists, so authenticated writes are RLS-denied outright.
select throws_ok(
  $$
  insert into public.agent_cost_reports (agent_id, org_id, models, tasks)
  values (
    '61000000-0000-0000-0000-000000000005',
    '61000000-0000-0000-0000-000000000001',
    '["model-a"]'::jsonb,
    '[]'::jsonb
  )
  $$,
  '42501',
  null,
  'authenticated members cannot insert cost reports'
);

reset role;

-- A user outside the org sees nothing.
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000098', true);
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.agent_cost_reports
    where id = '61000000-0000-0000-0000-000000000011'
  ),
  0,
  'non-members cannot read another org''s cost reports'
);

reset role;

-- Drift repair: recompute folds the report table with the same rules and
-- overwrites a corrupted counter.
update public.organizations
   set spend_usd = 999
 where id = '61000000-0000-0000-0000-000000000001';

select is(
  public.recompute_org_spend('61000000-0000-0000-0000-000000000001'),
  6.3::numeric,
  'recompute_org_spend reproduces the report total after counter corruption'
);

-- Deletes subtract, returning the counter to its prior value.
delete from public.agent_cost_reports
 where id = '61000000-0000-0000-0000-000000000011';

select is(pg_temp.org_spend(), 0::numeric, 'deleting a report refunds its spend');

-- The fold function's edge cases: null and empty payloads are zero, and a
-- non-object model entry is tolerated (contributes nothing).
select is(public.cost_report_usage_spend(null::jsonb), 0::numeric,
  'null usage folds to zero');
select is(public.cost_report_usage_spend('{}'::jsonb), 0::numeric,
  'empty usage folds to zero');
select is(public.cost_report_usage_spend('{"m": 3}'::jsonb), 0::numeric,
  'a non-object model entry folds to zero');
select is(
  public.cost_report_usage_spend(
    '{"m": {"worker": {"cost_usd": 1.0}, "meta": {"cost_usd": 0.4}, "sandbox": {"count": 3, "seconds": 100, "cost_usd": 9.9}, "meta_sandbox": {"cost_usd": 0.1}}}'::jsonb
  ),
  11.4::numeric,
  'model and sandbox meta legs feed the same budget counter as optimization runs');

-- Cascade: org_id is denormalized on the report, so when deleting the agent
-- cascades the report away, the spend subtraction still attributes.
insert into public.agent_cost_reports (id, agent_id, org_id, status, models, tasks, usage)
values (
  '61000000-0000-0000-0000-000000000012',
  '61000000-0000-0000-0000-000000000005',
  '61000000-0000-0000-0000-000000000001',
  'completed',
  '["model-a"]'::jsonb,
  '[{"task_id": "t1", "instruction": "pgtap task", "gold": "done"}]'::jsonb,
  '{"model-a": {"worker": {"cost_usd": 2.0}}}'::jsonb
);

select is(pg_temp.org_spend(), 2.0::numeric, 'a fresh priced report counts before the cascade');

delete from public.agents where id = '61000000-0000-0000-0000-000000000005';

select is(pg_temp.org_spend(), 0::numeric, 'an agent cascade refunds its reports'' spend');

select * from finish();

rollback;
