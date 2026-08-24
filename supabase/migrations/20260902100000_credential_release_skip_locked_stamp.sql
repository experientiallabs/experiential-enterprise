-- Credential release must never block (or deadlock) on the last_used_at stamp.
--
-- Two gateway workers cold-booting concurrently -- exactly what a hosting-platform
-- rolling deploy does -- each drive release_provider_connection_credential
-- for the same BYOK connection several times per catalog refresh (releasability
-- probe, then the state materialization's final release). The stamp's plain
-- UPDATE queued each caller on the sibling's row lock, and under the refresh
-- transaction shapes on both sides Postgres intermittently resolved the queue
-- as a deadlock (40P01, "while locking tuple ... in relation
-- provider_connections"). The losing worker's refresh raised
-- GatewayCredentialError and the worker exited during startup.
--
-- last_used_at is telemetry, not correctness, and has no readers today:
-- whether the lock holder is a sibling release stamping now() itself or a
-- dashboard rotation, skipping one best-effort write loses nothing worth a
-- lock wait. FOR UPDATE SKIP LOCKED makes the stamp strictly non-blocking;
-- the decrypted credential is returned either way.

create or replace function public.release_provider_connection_credential(in_connection_id uuid)
returns table (credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_vault uuid;
  released text;
begin
  select connections.vault_secret_id
  into target_vault
  from public.provider_connections connections
  where connections.id = in_connection_id;

  if target_vault is null then
    raise exception 'provider connection not found: %', in_connection_id;
  end if;

  select decrypted_secret
  into released
  from vault.decrypted_secrets
  where vault.decrypted_secrets.id = target_vault;

  if released is null then
    raise exception 'provider connection credential is not decryptable: %', in_connection_id;
  end if;

  -- Best-effort usage stamp: never wait on a sibling's lock (see header).
  update public.provider_connections
  set last_used_at = now()
  where provider_connections.id in (
    select locked.id
    from public.provider_connections locked
    where locked.id = in_connection_id
    for update skip locked
  );

  return query select released;
end;
$$;

-- create or replace preserves ownership and privileges; re-assert the grant
-- surface anyway so this file states the whole contract.
revoke all on function public.release_provider_connection_credential(uuid)
  from public, anon, authenticated;
grant execute on function public.release_provider_connection_credential(uuid)
  to service_role;
