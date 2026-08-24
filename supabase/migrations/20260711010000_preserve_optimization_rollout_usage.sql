-- Optimization episodes are durable billing/history records. Their parent
-- run is mutable product state, so deleting a run clears only the provenance
-- pointer and never cascades through already-incurred world-model usage.
-- A separate durable origin flag keeps those orphaned episodes off the
-- playground/session surface after the pointer is cleared.

alter table public.wm_rollouts
  add column is_optimization boolean not null default false;

update public.wm_rollouts
set is_optimization = true
where agent_opt_run_id is not null;

alter table public.wm_rollouts
  drop constraint wm_rollouts_agent_opt_run_id_fkey,
  add constraint wm_rollouts_agent_opt_run_id_fkey
    foreign key (agent_opt_run_id)
    references public.agent_opt_runs(id)
    on delete set null;

alter table public.wm_rollouts
  drop constraint wm_rollouts_optimization_not_forked,
  add constraint wm_rollouts_optimization_not_forked
    check (not is_optimization or (parent_rollout_id is null and fork_turn_index is null)),
  add constraint wm_rollouts_optimization_run_requires_origin
    check (agent_opt_run_id is null or is_optimization);

comment on column public.wm_rollouts.agent_opt_run_id is
  'Optimization run that emitted this simulated evaluation episode. The pointer clears when the run is deleted so incurred spend and transcript history remain.';

comment on column public.wm_rollouts.is_optimization is
  'True for internal optimization evaluation episodes. This durable origin marker remains true after agent_opt_run_id is cleared and keeps the episode off playground surfaces.';
