-- Proposal diversity is independent from evaluation repeats. Agents own the
-- per-iteration proposal count and each optimization run snapshots it with k.

alter table public.agents
  add column proposal_batch_size integer not null default 3
  check (proposal_batch_size > 0 and proposal_batch_size <= 5);

alter table public.agent_opt_runs
  add column proposal_batch_size integer;

-- Historical and already-queued runs were created under the old one-proposal
-- contract. Preserve that snapshot before making three the default for new runs.
update public.agent_opt_runs set proposal_batch_size = 1;

alter table public.agent_opt_runs
  alter column proposal_batch_size set default 3,
  alter column proposal_batch_size set not null,
  add check (proposal_batch_size > 0 and proposal_batch_size <= 5);

-- Proposal runs now meter the meta model and its persistent project sandbox as
-- first-class optimization legs. Keep organization budgets in sync with the
-- JSON payload the worker persists.
create or replace function public.opt_run_usage_spend(usage jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce((usage #>> '{worker,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{judge,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{world_model,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{meta,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{sandbox,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{meta_sandbox,cost_usd}')::numeric, 0);
$$;

-- Cost-report payloads use the same per-model usage shape in API reporting.
-- Keep their trigger and repair fold aligned if those records carry meta legs.
create or replace function public.cost_report_usage_spend(usage jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum(
      coalesce((model.legs -> 'worker' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'judge' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'world_model' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'meta' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'sandbox' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'meta_sandbox' ->> 'cost_usd')::numeric, 0)
  ), 0)
  from jsonb_each(coalesce(usage, '{}'::jsonb)) as model(model_id, legs)
  where jsonb_typeof(model.legs) = 'object';
$$;

select public.recompute_org_spend(orgs.id) from public.organizations orgs;
