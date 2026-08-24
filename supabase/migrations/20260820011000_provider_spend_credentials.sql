-- The optional second credential on a provider connection: the provider
-- ADMIN key (Anthropic sk-ant-admin…, OpenAI sk-admin-…), used ONLY for
-- spend reporting — admin and inference keys are disjoint namespaces at both
-- providers, so this key never serves traffic and the main key never reads
-- billing. Same Vault discipline as the main credential: the secret enters
-- through a definer RPC, leaves only through its release RPC, and only its
-- last four characters land on the member-readable row.

alter table public.provider_connections
  add column spend_vault_secret_id uuid,
  add column spend_credential_last4 text;

comment on column public.provider_connections.spend_vault_secret_id is
  'Vault id of the optional provider ADMIN key used only for spend reporting (Anthropic/OpenAI). Null = no admin key stored.';
comment on column public.provider_connections.spend_credential_last4 is
  'Last four characters of the stored admin key, for display; the secret itself lives in Vault.';

-- Store or rotate the admin key on an EXISTING connection: the admin key is
-- an add-on to a hooked-up provider, never a connection of its own.
create function public.set_provider_connection_spend_credential(
  in_org_id uuid,
  in_provider text,
  in_secret text,
  in_actor text default null
)
returns table (
  id uuid,
  provider text,
  spend_credential_last4 text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  actor text := nullif(btrim(in_actor), '');
  target_id uuid;
  existing_vault uuid;
  vault_secret uuid;
  vault_name text;
begin
  if normalized_provider is null then
    raise exception 'provider is required';
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'provider spend credential is required';
  end if;
  -- spend_credential_last4 is member-readable; a short secret would land in
  -- it whole. Real admin keys are far longer than this floor.
  if length(in_secret) < 12 then
    raise exception 'provider spend credential is too short to be a real API key';
  end if;

  select connections.id, connections.spend_vault_secret_id
  into target_id, existing_vault
  from public.provider_connections connections
  where connections.org_id = in_org_id
    and connections.provider = normalized_provider
  limit 1;

  if target_id is null then
    raise exception 'provider connection not found for org % provider %',
      in_org_id, normalized_provider;
  end if;

  vault_name := format(
    'org:%s:provider-connection-spend:%s:%s',
    in_org_id::text,
    normalized_provider,
    gen_random_uuid()::text
  );

  if existing_vault is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_provider);
  else
    perform vault.update_secret(existing_vault, in_secret, vault_name, normalized_provider);
    vault_secret := existing_vault;
  end if;

  -- No endpoints bump here: the admin key never serves traffic, so cached
  -- serving runtimes have nothing to rebuild.
  update public.provider_connections
  set
    spend_vault_secret_id = vault_secret,
    spend_credential_last4 = right(in_secret, 4),
    updated_by = actor,
    updated_at = now()
  where provider_connections.id = target_id;

  return query
    select
      connections.id,
      connections.provider,
      connections.spend_credential_last4
    from public.provider_connections connections
    where connections.id = target_id;
end;
$$;

revoke all on function public.set_provider_connection_spend_credential(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_provider_connection_spend_credential(uuid, text, text, text)
  to service_role;

-- Decrypt the admin key for a spend read. Deliberately does NOT stamp
-- last_used_at: that column means serving traffic, and a spend refresh is a
-- management-plane read.
create function public.release_provider_connection_spend_credential(in_connection_id uuid)
returns table (credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_vault uuid;
  released text;
begin
  select connections.spend_vault_secret_id
  into target_vault
  from public.provider_connections connections
  where connections.id = in_connection_id;

  if target_vault is null then
    raise exception 'provider connection has no spend credential: %', in_connection_id;
  end if;

  select decrypted_secret
  into released
  from vault.decrypted_secrets
  where vault.decrypted_secrets.id = target_vault;

  if released is null then
    raise exception 'provider connection spend credential is not decryptable: %',
      in_connection_id;
  end if;

  return query select released;
end;
$$;

revoke all on function public.release_provider_connection_spend_credential(uuid)
  from public, anon, authenticated;
grant execute on function public.release_provider_connection_spend_credential(uuid)
  to service_role;

-- Disconnect now drops BOTH Vault secrets with the row. Same signature and
-- semantics as before; only the spend-secret cleanup is new.
create or replace function public.delete_provider_connection(in_org_id uuid, in_provider text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  target_id uuid;
  target_vault uuid;
  target_spend_vault uuid;
begin
  select connections.id, connections.vault_secret_id, connections.spend_vault_secret_id
  into target_id, target_vault, target_spend_vault
  from public.provider_connections connections
  where connections.org_id = in_org_id
    and connections.provider = normalized_provider
  limit 1;

  if target_id is null then
    return false;
  end if;

  delete from public.provider_connections where provider_connections.id = target_id;
  delete from vault.secrets where vault.secrets.id = target_vault;
  if target_spend_vault is not null then
    delete from vault.secrets where vault.secrets.id = target_spend_vault;
  end if;
  -- Disconnect is a revocation: cached runtimes holding the released key must
  -- rebuild on the next request, not keep serving on it until a restart.
  update public.endpoints
  set updated_at = now()
  where endpoints.org_id = in_org_id;
  return true;
end;
$$;
