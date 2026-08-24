-- Usage accounting has exactly two customer-facing buckets per entity:
-- optimization and usage. Agent optimization evaluates real harnesses against
-- world models, so every simulated episode is a durable wm_rollouts row linked
-- to the run that caused it. Its environment-side cost belongs to world-model
-- usage; worker/judge/optimizer/E2B spend remains on agent_opt_runs and belongs
-- to agent optimization.

alter table public.wm_rollouts
  add column agent_opt_run_id uuid
    references public.agent_opt_runs(id) on delete cascade;

alter table public.wm_rollouts
  add constraint wm_rollouts_optimization_not_forked
  check (agent_opt_run_id is null or (parent_rollout_id is null and fork_turn_index is null));

create index wm_rollouts_agent_opt_run_idx
  on public.wm_rollouts (agent_opt_run_id)
  where agent_opt_run_id is not null;

comment on column public.wm_rollouts.agent_opt_run_id is
  'Optimization run that emitted this simulated evaluation episode; null for playground rollouts.';

-- E2B was added as a fourth optimization leg by the real-harness runtime PR.
-- Include it in the canonical spend function so budgets, admin totals, and
-- the agent optimization bucket account for every priced leg.
create or replace function public.opt_run_usage_spend(usage jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce((usage #>> '{worker,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{judge,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{world_model,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{sandbox,cost_usd}')::numeric, 0);
$$;

-- Existing rows may already carry sandbox spend. Repair every counter once;
-- future mutations flow through the existing track_opt_run_spend trigger.
select public.recompute_org_spend(orgs.id) from public.organizations orgs;
