-- Persisted per-organization spend counter: organizations.spend_usd mirrors
-- the priced-spend total the usage rollup reports, maintained by triggers on
-- every metered table so the budget check and the admin panel read one row
-- instead of scanning spend rows. Trigger-side arithmetic mirrors the
-- rollup's fold rules exactly:
--
--   wm_sessions      cost_usd                       (null = unpriced = $0)
--   wm_rollouts      cost_usd + wm_cost_usd         (each null = $0)
--   build_jobs       usage->total->cost_usd when positive; the engine
--                    tracker writes 0.0 for models missing from its price
--                    table, so a positive total means priced traffic (the
--                    same sentinel contract as the 20260709050000 backfill)
--   agent_opt_runs   usage->{worker,judge,world_model}->cost_usd (null = $0)
--
-- Deletes subtract, matching the rollup (a deleted row disappears from the
-- scan-based total too). So the delete leg works during cascades — when the
-- attributing parent row is already gone — build_jobs and agent_opt_runs
-- gain a denormalized org_id (filled by BEFORE INSERT triggers, so writers
-- stay untouched), like wm_rollouts.project_id before them.
-- Repair tool: recompute_org_spend(org_id) recomputes the counter from the
-- metered tables with the same rules.

alter table public.organizations
  add column spend_usd numeric(14, 6) not null default 0;

comment on column public.organizations.spend_usd is
  'Running priced spend in USD across sessions, rollouts, builds, and optimization runs; maintained by triggers to mirror the usage rollup. Repair with recompute_org_spend(org_id).';

-- Denormalized owning org, nullable for legacy rows whose parent is gone
-- (those rows attribute nowhere, matching the rollup's skip contract).
alter table public.build_jobs
  add column org_id uuid references public.organizations(id) on delete cascade;

update public.build_jobs jobs
   set org_id = models.org_id
  from public.world_models models
 where models.id = jobs.world_model_id;

alter table public.agent_opt_runs
  add column org_id uuid references public.organizations(id) on delete cascade;

update public.agent_opt_runs runs
   set org_id = agents.org_id
  from public.agents agents
 where agents.id = runs.agent_id;

create function public.fill_build_job_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    select models.org_id into new.org_id
      from public.world_models models
     where models.id = new.world_model_id;
  end if;
  return new;
end;
$$;

create trigger fill_build_job_org
before insert on public.build_jobs
for each row execute function public.fill_build_job_org();

create function public.fill_opt_run_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    select agents.org_id into new.org_id
      from public.agents agents
     where agents.id = new.agent_id;
  end if;
  return new;
end;
$$;

create trigger fill_opt_run_org
before insert on public.agent_opt_runs
for each row execute function public.fill_opt_run_org();

-- Shared counter bump; a no-op delta skips the row update.
create function public.apply_org_spend_delta(target_org uuid, delta numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_org is not null and delta is not null and delta <> 0 then
    update public.organizations
       set spend_usd = spend_usd + delta
     where id = target_org;
  end if;
end;
$$;

revoke all on function public.apply_org_spend_delta(uuid, numeric) from public, anon, authenticated;

-- A build usage payload's priced total: the tracker's positive totals are
-- priced spend; 0.0 is its unpriced-model sentinel and never counts.
create function public.build_usage_spend(usage jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce((usage #>> '{total,cost_usd}')::numeric, 0) > 0
      then (usage #>> '{total,cost_usd}')::numeric
    else 0
  end;
$$;

-- An optimization run usage payload's priced total: the worker writes each
-- leg's cost as priced dollars or null (never a $0 guess).
create function public.opt_run_usage_spend(usage jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce((usage #>> '{worker,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{judge,cost_usd}')::numeric, 0)
       + coalesce((usage #>> '{world_model,cost_usd}')::numeric, 0);
$$;

create function public.track_session_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
  end if;
  return null;
end;
$$;

create trigger track_session_spend
after insert or update of org_id, cost_usd or delete on public.wm_sessions
for each row execute function public.track_session_spend();

create function public.track_rollout_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(
      old.org_id, -(coalesce(old.cost_usd, 0) + coalesce(old.wm_cost_usd, 0)));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(
      new.org_id, coalesce(new.cost_usd, 0) + coalesce(new.wm_cost_usd, 0));
  end if;
  return null;
end;
$$;

create trigger track_rollout_spend
after insert or update of org_id, cost_usd, wm_cost_usd or delete on public.wm_rollouts
for each row execute function public.track_rollout_spend();

create function public.track_build_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(old.org_id, -public.build_usage_spend(old.usage));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, public.build_usage_spend(new.usage));
  end if;
  return null;
end;
$$;

create trigger track_build_spend
after insert or update of org_id, usage or delete on public.build_jobs
for each row execute function public.track_build_spend();

create function public.track_opt_run_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.apply_org_spend_delta(old.org_id, -public.opt_run_usage_spend(old.usage));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.apply_org_spend_delta(new.org_id, public.opt_run_usage_spend(new.usage));
  end if;
  return null;
end;
$$;

create trigger track_opt_run_spend
after insert or update of org_id, usage or delete on public.agent_opt_runs
for each row execute function public.track_opt_run_spend();

-- Recompute one org's counter from the metered tables (repair tool and
-- backfill). Same fold rules as the triggers.
create function public.recompute_org_spend(target_org uuid)
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
    into total;
  update public.organizations set spend_usd = total where id = target_org;
  return total;
end;
$$;

revoke all on function public.recompute_org_spend(uuid) from public, anon, authenticated;
grant execute on function public.recompute_org_spend(uuid) to service_role;

-- Backfill every existing org from its current metered rows.
select public.recompute_org_spend(orgs.id) from public.organizations orgs;
