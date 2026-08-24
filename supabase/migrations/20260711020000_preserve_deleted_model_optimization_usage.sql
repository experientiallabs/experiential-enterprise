-- Deleting a world model still removes its customer-facing playground history,
-- but optimization episodes are durable billing records. Delete playground
-- rows first, then let the FK clear the model pointer on the remaining
-- optimization rows so their spend and transcripts survive.

create function public.delete_world_model_playground_rollouts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.wm_rollouts
  where world_model_id = old.id
    and not is_optimization;
  return old;
end;
$$;

create trigger delete_world_model_playground_rollouts
before delete on public.world_models
for each row execute function public.delete_world_model_playground_rollouts();

alter table public.wm_rollouts
  alter column world_model_id drop not null,
  drop constraint wm_rollouts_world_model_id_fkey,
  add constraint wm_rollouts_world_model_id_fkey
    foreign key (world_model_id)
    references public.world_models(id)
    on delete set null;

comment on column public.wm_rollouts.world_model_id is
  'World model used by the rollout. Cleared only for retained optimization history when that model is deleted; live playground rows always have a model.';
