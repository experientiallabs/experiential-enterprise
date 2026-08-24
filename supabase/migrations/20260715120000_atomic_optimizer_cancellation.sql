-- Make optimizer cancellation one database-owned lifecycle transition.
--
-- The API previously cancelled the run and restored the agent in two
-- independent PostgREST writes. Once the first write released the active-run
-- slot, a new run could queue and mark the agent optimizing before the stale
-- second write reset it. Snapshot the pre-run state and restore it from an
-- AFTER UPDATE trigger in the same transaction as the terminal run change.
alter table public.agent_opt_runs
  add column resume_agent_status public.agent_status not null default 'created';

-- Preserve the best safe inference for a run already active during rollout.
-- New queue paths always write the exact source state explicitly.
update public.agent_opt_runs runs
set resume_agent_status = case
  when agents.best_score is not null then 'ready'::public.agent_status
  else 'created'::public.agent_status
end
from public.agents agents
where agents.id = runs.agent_id
  and runs.status in ('queued', 'claimed', 'running');

-- The route's preflight read is advisory. This partial unique index is the
-- authority when two optimizer starts pass that read concurrently.
create unique index agent_opt_runs_one_active_per_agent
  on public.agent_opt_runs (agent_id)
  where status in ('queued', 'claimed', 'running');

create function public.restore_agent_after_optimization_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The cross-work trigger and active-run index serialize competing starts on
  -- this same agent row. The source-state predicate is a final stale-worker
  -- guard and avoids overwriting an independently repaired lifecycle state.
  update public.agents
     set status = new.resume_agent_status,
         error = null,
         updated_at = now()
   where id = new.agent_id
     and status = 'optimizing';
  return new;
end;
$$;

revoke all on function public.restore_agent_after_optimization_cancel() from public;
revoke all on function public.restore_agent_after_optimization_cancel() from authenticated;

create trigger restore_agent_after_optimization_cancel
after update of status on public.agent_opt_runs
for each row
when (
  old.status in ('queued', 'claimed', 'running')
  and new.status = 'cancelled'
)
execute function public.restore_agent_after_optimization_cancel();
