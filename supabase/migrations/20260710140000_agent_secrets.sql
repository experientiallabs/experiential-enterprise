-- Agent-scoped user secrets. Each hosted agent gets a private set of
-- name/value pairs (env-var-shaped names, user-chosen) whose values live in
-- Supabase Vault; this table stores the metadata handle only, mirroring
-- public.org_secrets. Plaintext is released only through the service-role
-- RPC below, for a trusted harness capability to consume without exposing it
-- to the browser or the metadata API.
--
-- Access model: browser clients never touch this table or Vault. All reads
-- and writes go through the security-definer RPCs below, which are
-- EXECUTE-granted to service_role only; the web tier calls them with the
-- service-role client after its own agent-access check. A future trusted
-- harness runtime may call list_agent_secrets with the same role. RLS is
-- enabled with a service_role-only policy in this same migration because the
-- local stack blanket-grants SELECT on all public tables to authenticated/anon
-- after migrating — the policy, not the grants, is the fence.
create table public.agent_secrets (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- Denormalized like agents.org_id: org is the durable tenancy key.
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Env-var-shaped, uppercased by the upsert RPC. Reserved infra prefixes are
  -- rejected there and in the web route; the check here is the backstop.
  name text not null check (
    name ~ '^[A-Z][A-Z0-9_]*$'
    and char_length(name) <= 64
    and name !~ '^(SUPABASE_|EXPLABS_|MODAL_)'
  ),
  vault_secret_id uuid not null,
  last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb not null default '{}'::jsonb
);

-- One active value per name; revoked metadata stays behind as an audit trail,
-- while the Vault value is destroyed.
create unique index agent_secrets_active_agent_name
  on public.agent_secrets (agent_id, name)
  where revoked_at is null;

-- Covering indexes for the cascade FKs; the partial unique index above
-- excludes revoked rows, so it cannot serve FK cascade scans.
create index agent_secrets_agent_id_idx
  on public.agent_secrets (agent_id);

create index agent_secrets_org_id_idx
  on public.agent_secrets (org_id);

grant select, insert, update, delete on public.agent_secrets to service_role;

alter table public.agent_secrets enable row level security;

-- Trusted rows are written by the service role (which bypasses RLS); there is
-- deliberately NO authenticated policy — even metadata reaches the UI only
-- via the service-role RPC after an app-level access check.
create policy agent_secrets_service_role_rw
  on public.agent_secrets
  for all
  to service_role
  using (true)
  with check (true);

-- No set_updated_at trigger, deliberately: all writes go through the RPCs
-- below, which maintain updated_at themselves. A trigger would let the
-- last_used_at stamp every run performs rewrite updated_at, turning the
-- tab's "Updated" column into a run log (org_secrets has none either).

-- Create-or-rotate one agent secret. Runs as the table owner so the service
-- role can write Vault without direct Vault grants. Returns the metadata row;
-- the plaintext value is never returned by any RPC except list_agent_secrets.
create or replace function public.upsert_agent_secret(
  in_agent_id uuid,
  in_name text,
  in_secret text,
  in_updated_by text default null,
  in_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  agent_id uuid,
  org_id uuid,
  name text,
  last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz,
  updated_at timestamptz,
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
  target_org_id uuid;
  normalized_name text := upper(nullif(btrim(in_name), ''));
  actor text := nullif(btrim(in_updated_by), '');
  vault_secret uuid;
  existing_vault_secret uuid;
  vault_name text;
  value_last4 text;
begin
  if in_agent_id is null then
    raise exception 'agent_id is required';
  end if;
  if normalized_name is null then
    raise exception 'secret name is required';
  end if;
  if normalized_name !~ '^[A-Z][A-Z0-9_]*$' or char_length(normalized_name) > 64 then
    raise exception 'secret name must be an environment-variable-style identifier (A-Z, 0-9, _; max 64 chars): %', normalized_name;
  end if;
  if normalized_name ~ '^(SUPABASE_|EXPLABS_|MODAL_)' then
    raise exception 'secret name uses a reserved prefix: %', normalized_name;
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'secret value is required';
  end if;
  if length(in_secret) > 8192 then
    raise exception 'secret value exceeds the 8192 character limit';
  end if;

  select agents.org_id
  into target_org_id
  from public.agents
  where agents.id = in_agent_id;

  if target_org_id is null then
    raise exception 'agent not found: %', in_agent_id;
  end if;

  -- Serialize concurrent writes to one (agent, name): a create/create race
  -- would otherwise surface the partial unique index as a raw
  -- unique_violation, and a rotate could land on a row revoked in between.
  perform pg_advisory_xact_lock(
    hashtextextended('agent_secret:' || in_agent_id::text || ':' || normalized_name, 0)
  );

  select secrets.id, secrets.vault_secret_id
  into existing_secret_id, existing_vault_secret
  from public.agent_secrets secrets
  where secrets.agent_id = in_agent_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null
  limit 1;

  -- Short values keep no hint: right(value, 4) of a 4-character secret IS
  -- the secret, and last4 is member-visible metadata.
  value_last4 := case when length(in_secret) >= 8 then right(in_secret, 4) end;
  -- Vault names are unique, so every write gets a fresh uuid suffix; rotation
  -- reuses the existing Vault row via vault.update_secret.
  vault_name := format(
    'agent:%s:secret:%s:%s',
    in_agent_id::text,
    normalized_name,
    gen_random_uuid()::text
  );
  if existing_secret_id is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_name);

    insert into public.agent_secrets (
      agent_id,
      org_id,
      name,
      vault_secret_id,
      last4,
      created_by,
      updated_by,
      metadata
    )
    values (
      in_agent_id,
      target_org_id,
      normalized_name,
      vault_secret,
      value_last4,
      actor,
      actor,
      coalesce(in_metadata, '{}'::jsonb)
    )
    returning agent_secrets.id into existing_secret_id;
  else
    perform vault.update_secret(existing_vault_secret, in_secret, vault_name, normalized_name);

    update public.agent_secrets
    set
      last4 = value_last4,
      updated_by = actor,
      updated_at = now(),
      rotated_at = now(),
      metadata = coalesce(in_metadata, '{}'::jsonb)
    where agent_secrets.id = existing_secret_id;
  end if;

  return query
    select
      secrets.id,
      secrets.agent_id,
      secrets.org_id,
      secrets.name,
      secrets.last4,
      secrets.created_by,
      secrets.updated_by,
      secrets.created_at,
      secrets.updated_at,
      secrets.rotated_at,
      secrets.last_used_at,
      secrets.revoked_at,
      secrets.revoked_reason,
      secrets.metadata
    from public.agent_secrets secrets
    where secrets.id = existing_secret_id;
end;
$$;

-- Decrypted name/value rows for a trusted harness runtime. Values must never
-- be returned to browsers, persisted, or logged by callers.
create or replace function public.list_agent_secrets(in_agent_id uuid)
returns table (
  name text,
  value text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  undecryptable_name text;
begin
  if in_agent_id is null then
    raise exception 'agent_id is required';
  end if;

  -- An active row whose Vault entry no longer decrypts must fail the run
  -- loudly: silently dropping it would start the run without a secret the
  -- management API still shows as active.
  select secrets.name
  into undecryptable_name
  from public.agent_secrets secrets
  where secrets.agent_id = in_agent_id
    and secrets.revoked_at is null
    and not exists (
      select 1
      from vault.decrypted_secrets decrypted
      where decrypted.id = secrets.vault_secret_id
    )
  limit 1;

  if undecryptable_name is not null then
    raise exception 'agent secret % cannot be decrypted; its Vault entry is missing', undecryptable_name;
  end if;

  update public.agent_secrets secrets
  set last_used_at = now()
  where secrets.agent_id = in_agent_id
    and secrets.revoked_at is null;

  return query
    select
      secrets.name,
      decrypted.decrypted_secret as value
    from public.agent_secrets secrets
    join vault.decrypted_secrets decrypted
      on decrypted.id = secrets.vault_secret_id
    where secrets.agent_id = in_agent_id
      and secrets.revoked_at is null;
end;
$$;

-- Metadata (never values) for the management API: name, last4, timestamps.
create or replace function public.list_agent_secret_metadata(in_agent_id uuid)
returns table (
  id uuid,
  agent_id uuid,
  org_id uuid,
  name text,
  last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz,
  updated_at timestamptz,
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    secrets.id,
    secrets.agent_id,
    secrets.org_id,
    secrets.name,
    secrets.last4,
    secrets.created_by,
    secrets.updated_by,
    secrets.created_at,
    secrets.updated_at,
    secrets.rotated_at,
    secrets.last_used_at,
    secrets.revoked_at,
    secrets.revoked_reason,
    secrets.metadata
  from public.agent_secrets secrets
  where secrets.agent_id = in_agent_id
    and secrets.revoked_at is null
  order by secrets.name;
$$;

-- Remove one active secret. The metadata row stays behind as an audit trail,
-- while the Vault value is destroyed; the partial unique index frees the name
-- for re-use.
-- Returns false when no active secret matched, so callers can 404.
create or replace function public.revoke_agent_secret(
  in_agent_id uuid,
  in_name text,
  in_updated_by text default null,
  in_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := upper(nullif(btrim(in_name), ''));
  actor text := nullif(btrim(in_updated_by), '');
  revoked_count integer;
  target_vault uuid;
begin
  if in_agent_id is null or normalized_name is null then
    raise exception 'agent_id and secret name are required';
  end if;

  -- Same per-(agent, name) lock as upsert_agent_secret, so a revoke cannot
  -- interleave with a rotate on the same row.
  perform pg_advisory_xact_lock(
    hashtextextended('agent_secret:' || in_agent_id::text || ':' || normalized_name, 0)
  );

  select secrets.vault_secret_id
  into target_vault
  from public.agent_secrets secrets
  where secrets.agent_id = in_agent_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null
  limit 1;

  if target_vault is null then
    return false;
  end if;

  update public.agent_secrets secrets
  set
    revoked_at = now(),
    revoked_reason = nullif(btrim(in_reason), ''),
    updated_by = actor,
    updated_at = now()
  where secrets.agent_id = in_agent_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null;

  get diagnostics revoked_count = row_count;
  delete from vault.secrets where id = target_vault;
  return revoked_count > 0;
end;
$$;

revoke all on function public.upsert_agent_secret(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.list_agent_secrets(uuid)
  from public, anon, authenticated;
revoke all on function public.list_agent_secret_metadata(uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_agent_secret(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.upsert_agent_secret(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.list_agent_secrets(uuid)
  to service_role;
grant execute on function public.list_agent_secret_metadata(uuid)
  to service_role;
grant execute on function public.revoke_agent_secret(uuid, text, text, text)
  to service_role;
