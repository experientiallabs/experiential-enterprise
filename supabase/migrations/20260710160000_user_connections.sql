-- Account-level provider connections, and the per-agent opt-ins that
-- reference them. A user connects GitHub ONCE (the OAuth callback stores the
-- minted token in Supabase Vault via the RPCs below, plus the provider
-- account id/handle for display); each agent then enables the connection
-- with a lightweight reference row. Disconnecting the account revokes the
-- token and removes every agent reference in one transaction — the grant is
-- personal, so it dies with the person, everywhere, at once.
--
-- user_id deliberately has NO foreign key: GoTrue owns auth.users and
-- creates it after migrations run on a fresh stack. We trust the verified
-- JWT subject, exactly like organization_members.user_id.
--
-- Access model mirrors agent_secrets: browser clients never touch these
-- tables or Vault. All reads and writes go through security-definer RPCs
-- EXECUTE-granted to service_role only; RLS is enabled with no authenticated
-- policy in this same migration because the local stack blanket-grants
-- SELECT on all public tables after migrating — the policy is the fence.

create table public.user_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  -- Catalog provider key, slug-shaped (e.g. 'github').
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9_-]*$'),
  vault_secret_id uuid not null,
  -- Provider-side identity, for "Connected as @handle" display.
  account_id text,
  account_handle text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
);

-- One active connection per (user, provider); revoked metadata stays behind
-- as an audit trail, while the Vault token is destroyed.
create unique index user_connections_active_user_provider
  on public.user_connections (user_id, provider)
  where revoked_at is null;

create index user_connections_user_id_idx
  on public.user_connections (user_id);

grant select, insert, update, delete on public.user_connections to service_role;

alter table public.user_connections enable row level security;

create policy user_connections_service_role_rw
  on public.user_connections
  for all
  to service_role
  using (true)
  with check (true);

-- One agent opting in to one account-level connection. Deleting the
-- connection row (never done today; disconnect soft-revokes and clears
-- references via the RPC) would cascade; deleting the agent always does.
create table public.agent_connectors (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- Denormalized like agents.org_id: org is the durable tenancy key.
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Catalog key, slug-shaped like agents.name.
  connector_key text not null check (connector_key ~ '^[a-z0-9][a-z0-9_-]*$'),
  connection_id uuid not null references public.user_connections(id) on delete cascade,
  created_by text,
  created_at timestamptz not null default now(),
  unique (agent_id, connector_key)
);

create index agent_connectors_org_id_idx
  on public.agent_connectors (org_id);

create index agent_connectors_connection_id_idx
  on public.agent_connectors (connection_id);

grant select on public.agent_connectors to authenticated;
grant select, insert, update, delete on public.agent_connectors to service_role;

alter table public.agent_connectors enable row level security;

-- References carry no secret material (the token lives behind
-- user_connections' service-role fence), so org members may read which
-- connectors their agents have enabled.
create policy agent_connectors_select_member
  on public.agent_connectors
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- Create-or-reconnect one account-level connection. Runs as the table owner
-- so the service role can write Vault without direct Vault grants. Returns
-- the metadata row; plaintext is released only to the provider-revocation
-- path and the trusted connector runtime RPC.
create or replace function public.upsert_user_connection(
  in_user_id uuid,
  in_provider text,
  in_secret text,
  in_account_id text default null,
  in_account_handle text default null,
  in_updated_by text default null
)
returns table (
  id uuid,
  user_id uuid,
  provider text,
  account_id text,
  account_handle text,
  created_at timestamptz,
  updated_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  existing_vault_secret uuid;
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  actor text := nullif(btrim(in_updated_by), '');
  vault_secret uuid;
  vault_name text;
begin
  if in_user_id is null then
    raise exception 'user_id is required';
  end if;
  if normalized_provider is null or normalized_provider !~ '^[a-z0-9][a-z0-9_-]*$' then
    raise exception 'provider must be a slug: %', in_provider;
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'connection token is required';
  end if;
  if length(in_secret) > 8192 then
    raise exception 'connection token exceeds the 8192 character limit';
  end if;

  -- Serialize concurrent connects for one (user, provider): a create/create
  -- race would otherwise surface the partial unique index as a raw
  -- unique_violation.
  perform pg_advisory_xact_lock(
    hashtextextended('user_connection:' || in_user_id::text || ':' || normalized_provider, 0)
  );

  select connections.id, connections.vault_secret_id
  into existing_id, existing_vault_secret
  from public.user_connections connections
  where connections.user_id = in_user_id
    and connections.provider = normalized_provider
    and connections.revoked_at is null
  limit 1;

  -- Vault names are unique, so every write gets a fresh uuid suffix;
  -- reconnecting reuses the existing Vault row via vault.update_secret.
  vault_name := format(
    'user:%s:connection:%s:%s',
    in_user_id::text,
    normalized_provider,
    gen_random_uuid()::text
  );
  if existing_id is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_provider);

    insert into public.user_connections (
      user_id,
      provider,
      vault_secret_id,
      account_id,
      account_handle,
      created_by,
      updated_by
    )
    values (
      in_user_id,
      normalized_provider,
      vault_secret,
      in_account_id,
      in_account_handle,
      actor,
      actor
    )
    returning user_connections.id into existing_id;
  else
    perform vault.update_secret(existing_vault_secret, in_secret, vault_name, normalized_provider);

    update public.user_connections
    set
      account_id = in_account_id,
      account_handle = in_account_handle,
      updated_by = actor,
      updated_at = now()
    where user_connections.id = existing_id;
  end if;

  return query
    select
      connections.id,
      connections.user_id,
      connections.provider,
      connections.account_id,
      connections.account_handle,
      connections.created_at,
      connections.updated_at,
      connections.last_used_at
    from public.user_connections connections
    where connections.id = existing_id;
end;
$$;

-- The caller's active connections: metadata only, never tokens.
create or replace function public.list_user_connections(in_user_id uuid)
returns table (
  id uuid,
  user_id uuid,
  provider text,
  account_id text,
  account_handle text,
  created_at timestamptz,
  updated_at timestamptz,
  last_used_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    connections.id,
    connections.user_id,
    connections.provider,
    connections.account_id,
    connections.account_handle,
    connections.created_at,
    connections.updated_at,
    connections.last_used_at
  from public.user_connections connections
  where connections.user_id = in_user_id
    and connections.revoked_at is null
  order by connections.provider;
$$;

-- The decrypted token for one active connection, or null. The disconnect
-- route uses it to revoke the credential at the provider before deleting our
-- Vault copy; it is never exposed to browsers.
create or replace function public.get_user_connection_secret(
  in_user_id uuid,
  in_provider text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  vault_secret uuid;
  secret_value text;
begin
  if in_user_id is null or normalized_provider is null then
    raise exception 'user_id and provider are required';
  end if;

  select connections.vault_secret_id
  into vault_secret
  from public.user_connections connections
  where connections.user_id = in_user_id
    and connections.provider = normalized_provider
    and connections.revoked_at is null
  limit 1;

  if vault_secret is null then
    return null;
  end if;

  select decrypted.decrypted_secret
  into secret_value
  from vault.decrypted_secrets decrypted
  where decrypted.id = vault_secret
  limit 1;

  return secret_value;
end;
$$;

-- Disconnect one provider account: revoke the token AND remove every agent
-- reference in the same transaction, so no agent keeps a grant its owner
-- withdrew. The Vault value is destroyed while the metadata row remains for
-- audit. Returns false when no active connection matched.
create or replace function public.revoke_user_connection(
  in_user_id uuid,
  in_provider text,
  in_updated_by text default null,
  in_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  actor text := nullif(btrim(in_updated_by), '');
  target_id uuid;
  target_vault uuid;
begin
  if in_user_id is null or normalized_provider is null then
    raise exception 'user_id and provider are required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('user_connection:' || in_user_id::text || ':' || normalized_provider, 0)
  );

  select connections.id, connections.vault_secret_id
  into target_id, target_vault
  from public.user_connections connections
  where connections.user_id = in_user_id
    and connections.provider = normalized_provider
    and connections.revoked_at is null
  limit 1;

  if target_id is null then
    return false;
  end if;

  delete from public.agent_connectors
  where agent_connectors.connection_id = target_id;

  update public.user_connections
  set
    revoked_at = now(),
    revoked_reason = nullif(btrim(in_reason), ''),
    updated_by = actor,
    updated_at = now()
  where user_connections.id = target_id;

  delete from vault.secrets
  where id = target_vault;

  return true;
end;
$$;

-- Decrypted credentials for one agent's enabled connectors. A trusted
-- connector runtime (including a future native MCP host) uses
-- connector_key/provider to select the server and authentication strategy;
-- values must never be persisted or logged by callers.
create or replace function public.list_agent_connector_credentials(in_agent_id uuid)
returns table (
  connector_key text,
  provider text,
  value text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  undecryptable_provider text;
begin
  if in_agent_id is null then
    raise exception 'agent_id is required';
  end if;

  -- The connection owner must still be an org member when the token is
  -- released. An enabled connector whose Vault entry no longer decrypts must
  -- fail credential release loudly: silently dropping it would omit a grant
  -- the Connectors tab still shows as enabled.
  select connections.provider
  into undecryptable_provider
  from public.agent_connectors connectors
  join public.user_connections connections
    on connections.id = connectors.connection_id
  where connectors.agent_id = in_agent_id
    and connections.revoked_at is null
    and exists (
      select 1
      from public.organization_members members
      where members.user_id = connections.user_id
        and members.org_id = connectors.org_id
        and members.role in ('admin', 'member')
    )
    and not exists (
      select 1
      from vault.decrypted_secrets decrypted
      where decrypted.id = connections.vault_secret_id
    )
  limit 1;

  if undecryptable_provider is not null then
    raise exception 'connector % cannot be decrypted; its Vault entry is missing', undecryptable_provider;
  end if;

  update public.user_connections connections
  set last_used_at = now()
  where connections.revoked_at is null
    and connections.id in (
      select connectors.connection_id
      from public.agent_connectors connectors
      where connectors.agent_id = in_agent_id
        and exists (
          select 1
          from public.organization_members members
          where members.user_id = connections.user_id
            and members.org_id = connectors.org_id
            and members.role in ('admin', 'member')
        )
    );

  return query
    select
      connectors.connector_key,
      connections.provider,
      decrypted.decrypted_secret as value
    from public.agent_connectors connectors
    join public.user_connections connections
      on connections.id = connectors.connection_id
    join vault.decrypted_secrets decrypted
      on decrypted.id = connections.vault_secret_id
    where connectors.agent_id = in_agent_id
      and connections.revoked_at is null
      and exists (
        select 1
        from public.organization_members members
        where members.user_id = connections.user_id
          and members.org_id = connectors.org_id
          and members.role in ('admin', 'member')
      );
end;
$$;

revoke all on function public.upsert_user_connection(uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.list_user_connections(uuid)
  from public, anon, authenticated;
revoke all on function public.get_user_connection_secret(uuid, text)
  from public, anon, authenticated;
revoke all on function public.revoke_user_connection(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.list_agent_connector_credentials(uuid)
  from public, anon, authenticated;

grant execute on function public.upsert_user_connection(uuid, text, text, text, text, text)
  to service_role;
grant execute on function public.list_user_connections(uuid)
  to service_role;
grant execute on function public.get_user_connection_secret(uuid, text)
  to service_role;
grant execute on function public.revoke_user_connection(uuid, text, text, text)
  to service_role;
grant execute on function public.list_agent_connector_credentials(uuid)
  to service_role;
