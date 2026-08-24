-- Atomic compensation for a failed import.
--
-- The import route performs follow-up writes (cloning the entry's corpus,
-- recording the catalog-import build) after the counted world_models insert
-- committed. When one fails, the compensation must be all-or-nothing: the
-- previous two-call rollback (delete row, then give back the download) could
-- leak the counter if the second call died. One SQL function runs both in a
-- single transaction — and also removes the cloned trace rows, which the
-- model delete alone would orphan (its FK is ON DELETE SET NULL).
drop function public.uncount_catalog_import(uuid);

create or replace function public.rollback_catalog_import(
  in_world_model_id uuid,
  in_entry_id uuid
)
returns void
language sql
set search_path = ''
as $$
  delete from public.trace_uploads
   where trace_uploads.world_model_id = in_world_model_id;
  delete from public.world_models
   where world_models.id = in_world_model_id;
  update public.wm_catalog_entries
     set import_count = greatest(import_count - 1, 0)
   where id = in_entry_id;
$$;

revoke all on function public.rollback_catalog_import(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.rollback_catalog_import(uuid, uuid) to service_role;
