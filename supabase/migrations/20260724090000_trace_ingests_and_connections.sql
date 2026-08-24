-- Streaming trace ingest (D-INGEST): durable ingest rows plus org-scoped
-- observability/database connections whose credentials live in Vault.
--
-- trace_connections stores ONE connection per (org, kind): the non-secret
-- config (host/project) sits on the row, the credential (API key or DSN) is a
-- Vault secret referenced by vault_secret_id. Storing the connection (not just
-- using the credential once) is deliberate: continual learning re-pulls a
-- tenant's traces later without re-entering keys. Credentials enter through
-- upsert_trace_connection (create or rotate) and leave ONLY through
-- release_trace_connection_credential, both service-role RPCs; no credential
-- byte is ever on the row, in an event payload, or in an API response.
--
-- trace_ingests is the durable handle behind POST /api/orgs/{org}/trace-ingests
-- and its SSE stream: the sanitized source (credentials stripped), the storage
-- paths, and the terminal outcome so a reconnect can replay it.

create table public.trace_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (
    kind in ('phoenix', 'langfuse', 'langsmith', 'braintrust', 'posthog', 'mastra', 'postgres')
  ),
  -- Non-secret connection config (host, project id, ...); never the credential.
  config jsonb not null default '{}'::jsonb,
  vault_secret_id uuid not null,
  credential_last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (org_id, kind)
);

create index trace_connections_org_id_idx on public.trace_connections (org_id);

alter table public.trace_connections enable row level security;

create policy trace_connections_select_member
  on public.trace_connections
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create table public.trace_ingests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  world_model_id uuid references public.world_models(id) on delete set null,
  connection_id uuid references public.trace_connections(id) on delete set null,
  -- The requested source with credential fields stripped (see the route).
  source jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'running', 'done', 'error')
  ),
  upload_path text,
  result_path text,
  trace_upload_id uuid references public.trace_uploads(id) on delete set null,
  trace_count integer,
  step_count integer,
  error_message text,
  error_code text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index trace_ingests_org_id_idx on public.trace_ingests (org_id);
create index trace_ingests_world_model_id_idx on public.trace_ingests (world_model_id);
create index trace_ingests_connection_id_idx on public.trace_ingests (connection_id);
create index trace_ingests_trace_upload_id_idx on public.trace_ingests (trace_upload_id);

alter table public.trace_ingests enable row level security;

create policy trace_ingests_select_member
  on public.trace_ingests
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- Create or rotate one org connection's credential. Rotation updates the
-- existing Vault secret in place (same pattern as upsert_user_connection).
create function public.upsert_trace_connection(
  in_org_id uuid,
  in_kind text,
  in_config jsonb,
  in_secret text,
  in_actor text default null
)
returns table (
  id uuid,
  org_id uuid,
  kind text,
  config jsonb,
  credential_last4 text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_kind text := lower(nullif(btrim(in_kind), ''));
  actor text := nullif(btrim(in_actor), '');
  existing_id uuid;
  existing_vault uuid;
  vault_secret uuid;
  vault_name text;
begin
  if normalized_kind is null then
    raise exception 'connection kind is required';
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'connection credential is required';
  end if;
  if not exists (select 1 from public.organizations where organizations.id = in_org_id) then
    raise exception 'organization not found: %', in_org_id;
  end if;

  select connections.id, connections.vault_secret_id
  into existing_id, existing_vault
  from public.trace_connections connections
  where connections.org_id = in_org_id
    and connections.kind = normalized_kind
  limit 1;

  vault_name := format(
    'org:%s:trace-connection:%s:%s',
    in_org_id::text,
    normalized_kind,
    gen_random_uuid()::text
  );

  if existing_id is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_kind);
    insert into public.trace_connections (
      org_id, kind, config, vault_secret_id, credential_last4, created_by, updated_by
    )
    values (
      in_org_id,
      normalized_kind,
      coalesce(in_config, '{}'::jsonb),
      vault_secret,
      right(in_secret, 4),
      actor,
      actor
    )
    returning trace_connections.id into existing_id;
  else
    perform vault.update_secret(existing_vault, in_secret, vault_name, normalized_kind);
    update public.trace_connections
    set
      config = coalesce(in_config, '{}'::jsonb),
      credential_last4 = right(in_secret, 4),
      updated_by = actor,
      updated_at = now()
    where trace_connections.id = existing_id;
  end if;

  return query
    select
      connections.id,
      connections.org_id,
      connections.kind,
      connections.config,
      connections.credential_last4
    from public.trace_connections connections
    where connections.id = existing_id;
end;
$$;

revoke all on function public.upsert_trace_connection(uuid, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_trace_connection(uuid, text, jsonb, text, text)
  to service_role;

-- Decrypt one connection's credential for an ingest run. An undecryptable
-- Vault entry fails loudly; releases stamp last_used_at.
create function public.release_trace_connection_credential(in_connection_id uuid)
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
  from public.trace_connections connections
  where connections.id = in_connection_id;

  if target_vault is null then
    raise exception 'trace connection not found: %', in_connection_id;
  end if;

  select decrypted_secret
  into released
  from vault.decrypted_secrets
  where vault.decrypted_secrets.id = target_vault;

  if released is null then
    raise exception 'trace connection credential is not decryptable: %', in_connection_id;
  end if;

  update public.trace_connections
  set last_used_at = now()
  where trace_connections.id = in_connection_id;

  return query select released;
end;
$$;

revoke all on function public.release_trace_connection_credential(uuid)
  from public, anon, authenticated;
grant execute on function public.release_trace_connection_credential(uuid)
  to service_role;
