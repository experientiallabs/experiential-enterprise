-- A world model owns its bound trace uploads and bundle artifacts. Deleting
-- the model must remove that metadata instead of leaving project-scoped rows
-- whose world_model_id was silently nulled. The remaining model graph already
-- cascades through builds, sessions/steps, rollouts/turns, and agents with
-- their optimization runs and harness versions.

alter table public.artifacts
  drop constraint artifacts_world_model_id_fkey,
  add constraint artifacts_world_model_id_fkey
    foreign key (world_model_id)
    references public.world_models(id)
    on delete cascade;

alter table public.trace_uploads
  drop constraint trace_uploads_world_model_id_fkey,
  add constraint trace_uploads_world_model_id_fkey
    foreign key (world_model_id)
    references public.world_models(id)
    on delete cascade;
