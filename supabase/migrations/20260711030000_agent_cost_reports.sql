-- Agent cost reports: one row per multi-model cost/quality analysis of an
-- agent's champion harness.
--
-- A report evaluates the champion harness closed-loop on a snapshot of the
-- agent's newest mined task suite, once per user-selected catalog model
-- (k passes per task; metrics are means over k), metering every LLM leg.
-- The row mirrors the `agent_opt_runs` worker lifecycle (queued -> claimed ->
-- running -> completed/failed, stalled by the reaper) so a stale worker
-- cannot regress state, and its priced spend feeds the org spend counter
-- through the same trigger machinery as the other metered tables
-- (see 20260709150000_org_spend_counters). RLS mirrors agents: the service
-- role writes, org members read.

create type public.agent_cost_report_status as enum (
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'stalled'
);

create table public.agent_cost_reports (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- Denormalized from the agent so the spend trigger's delete leg can still
  -- attribute during a cascade (the agent row is already gone by then) and
  -- the rollup reads an org's reports in one filtered query.
  org_id uuid not null references public.organizations(id) on delete cascade,
  status public.agent_cost_report_status not null default 'queued',
  -- Agent-model catalog ids selected for the comparison, in report order.
  models jsonb not null,
  -- Eval passes per task per model (metrics are means over k, never
  -- single-pass).
  k integer not null default 3 check (k > 0),
  -- Task suite snapshot the report evaluates EVERY model on: copied from the
  -- newest mined optimization run at queue time, so per-model scores stay
  -- comparable and the report is self-contained once that run is deleted.
  tasks jsonb not null,
  -- Optimization run the suite was copied from (provenance only).
  source_run_id uuid references public.agent_opt_runs(id) on delete set null,
  -- Started by a platform admin: the worker skips mid-report budget checks,
  -- mirroring the admin exemption of the route-level pre-spend gate.
  budget_exempt boolean not null default false,
  runtime_backend text,
  runtime_call_id text,
  worker_id text,
  heartbeat_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  -- Per-model outcome summary written at completion:
  -- {models: [{model_id, label, status, success_rate, mean_fraction,
  -- success_std, error}], task_count}.
  result jsonb,
  -- Metered usage keyed by catalog model id, each value the three-leg
  -- {worker|judge|world_model: {input_tokens, output_tokens, calls,
  -- cost_usd|null}} shape optimization runs persist, plus a sandbox
  -- execution leg ({count, seconds, cost_usd}) for the model's E2B rollouts
  -- (all four legs feed the org budget counter, like optimization runs).
  -- The worker leg prices with the agent-model catalog; the judge and
  -- world-model legs price with the owning model's serve model (null when
  -- unpriced — never a guessed $0). Written incrementally as each model
  -- finishes so an aborted report still accounts for the spend it incurred.
  usage jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index agent_cost_reports_agent_created_idx
  on public.agent_cost_reports (agent_id, created_at desc);

create index agent_cost_reports_org_idx
  on public.agent_cost_reports (org_id);

-- DB backstop for the API's check-then-act mutual-exclusion read: two
-- concurrent starts can both pass the route's active-work check, so at most
-- one active report per agent is enforced here (the route surfaces the
-- violation as the same 409).
create unique index agent_cost_reports_one_active_per_agent
  on public.agent_cost_reports (agent_id)
  where status in ('queued', 'claimed', 'running');

-- Optimization runs and cost reports are mutually exclusive PER AGENT, and
-- the per-table index cannot see across tables: a run start racing a report
-- start (one insert per table) would slip through. Both inserts first take
-- the agent row lock, so the cross-table check below is serialized and
-- race-free. Terminal-status inserts (backfills, fixtures) pass untouched.
-- Raised as unique_violation so the routes' existing 23505 -> 409 mapping
-- covers both backstops.
create function public.assert_agent_work_exclusive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('queued', 'claimed', 'running') then
    return new;
  end if;
  perform 1 from public.agents where id = new.agent_id for update;
  if tg_table_name = 'agent_cost_reports' then
    if exists (
      select 1
      from public.agent_opt_runs runs
      where runs.agent_id = new.agent_id
        and runs.status in ('queued', 'claimed', 'running')
    ) then
      raise exception 'agent % already has an active optimization run', new.agent_id
        using errcode = '23505';
    end if;
  elsif exists (
    select 1
    from public.agent_cost_reports reports
    where reports.agent_id = new.agent_id
      and reports.status in ('queued', 'claimed', 'running')
  ) then
    raise exception 'agent % already has an active cost report', new.agent_id
      using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger assert_cost_report_work_exclusive
before insert on public.agent_cost_reports
for each row execute function public.assert_agent_work_exclusive();

create trigger assert_opt_run_work_exclusive
before insert on public.agent_opt_runs
for each row execute function public.assert_agent_work_exclusive();

alter table public.agent_cost_reports enable row level security;

create policy agent_cost_reports_select_member
  on public.agent_cost_reports
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- A model analysis usage payload's priced total: every model's legs —
-- worker/judge/world_model plus the E2B sandbox execution leg — carry cost
-- as priced dollars or null (never a $0 guess), so nulls fold to zero. The
-- sandbox leg counts toward the budget exactly like optimization runs
-- (opt_run_usage_spend folds all four legs since 20260710210000). Non-object
-- entries contribute nothing.
create function public.cost_report_usage_spend(usage jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum(
      coalesce((model.legs -> 'worker' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'judge' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'world_model' ->> 'cost_usd')::numeric, 0)
    + coalesce((model.legs -> 'sandbox' ->> 'cost_usd')::numeric, 0)
  ), 0)
  from jsonb_each(coalesce(usage, '{}'::jsonb)) as model(model_id, legs)
  where jsonb_typeof(model.legs) = 'object';
$$;

create function public.track_cost_report_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(old.org_id, -public.cost_report_usage_spend(old.usage));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, public.cost_report_usage_spend(new.usage));
  end if;
  return null;
end;
$$;

create trigger track_cost_report_spend
after insert or update of org_id, usage or delete on public.agent_cost_reports
for each row execute function public.track_cost_report_spend();

-- Extend the counter repair tool with the new metered table; the fold rules
-- must stay identical to the triggers' (see 20260709150000).
create or replace function public.recompute_org_spend(target_org uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  total numeric;
begin
  select coalesce((
      select sum(coalesce(sessions.cost_usd, 0))
        from public.wm_sessions sessions
       where sessions.org_id = target_org), 0)
       + coalesce((
      select sum(coalesce(rollouts.cost_usd, 0) + coalesce(rollouts.wm_cost_usd, 0))
        from public.wm_rollouts rollouts
       where rollouts.org_id = target_org), 0)
       + coalesce((
      select sum(public.build_usage_spend(jobs.usage))
        from public.build_jobs jobs
       where jobs.org_id = target_org), 0)
       + coalesce((
      select sum(public.opt_run_usage_spend(runs.usage))
        from public.agent_opt_runs runs
       where runs.org_id = target_org), 0)
       + coalesce((
      select sum(public.cost_report_usage_spend(reports.usage))
        from public.agent_cost_reports reports
       where reports.org_id = target_org), 0)
    into total;
  update public.organizations set spend_usd = total where id = target_org;
  return total;
end;
$$;

revoke all on function public.cost_report_usage_spend(jsonb) from public, anon, authenticated;
revoke all on function public.assert_agent_work_exclusive() from public, anon, authenticated;
revoke all on function public.recompute_org_spend(uuid) from public, anon, authenticated;
grant execute on function public.recompute_org_spend(uuid) to service_role;
