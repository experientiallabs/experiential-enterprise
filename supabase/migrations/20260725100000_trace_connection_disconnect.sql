-- Disconnect a stored trace connection (Settings > Integrations). The
-- upsert/release pair (20260724090000) covers create, rotate, and use;
-- disconnect is the missing exit: remove the row AND its Vault secret so no
-- orphaned credential outlives the connection. Service-role only; the web
-- route gates on org admin. trace_ingests.connection_id is ON DELETE SET
-- NULL, so ingest history survives a disconnect.

create function public.delete_trace_connection(in_org_id uuid, in_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_kind text := lower(nullif(btrim(in_kind), ''));
  target_id uuid;
  target_vault uuid;
begin
  select connections.id, connections.vault_secret_id
  into target_id, target_vault
  from public.trace_connections connections
  where connections.org_id = in_org_id
    and connections.kind = normalized_kind
  limit 1;

  if target_id is null then
    return false;
  end if;

  delete from public.trace_connections where id = target_id;
  delete from vault.secrets where id = target_vault;
  return true;
end;
$$;

revoke all on function public.delete_trace_connection(uuid, text)
  from public, anon, authenticated;
grant execute on function public.delete_trace_connection(uuid, text) to service_role;
