-- Compensating decrement for rolled-back imports.
--
-- The import fence trigger meters downloads atomically with the importing
-- insert, but the route performs one follow-up write (cloning the entry's
-- trace corpus row) that can fail after the insert committed. The route then
-- deletes the half-imported model and must give the download back — without
-- this, every compensated rollback permanently inflates import_count.
-- Floored at zero so a stray call can never underflow the counter.
create or replace function public.uncount_catalog_import(in_entry_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.wm_catalog_entries
     set import_count = greatest(import_count - 1, 0)
   where id = in_entry_id;
$$;

revoke all on function public.uncount_catalog_import(uuid)
  from public, anon, authenticated;
grant execute on function public.uncount_catalog_import(uuid) to service_role;
