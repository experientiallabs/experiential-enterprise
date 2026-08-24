-- Experiential Labs world-model platform schema, part 1 of 3: extensions,
-- tenancy tables, project secrets with Vault RPCs, signup org provisioning,
-- and the artifacts metadata table. Part 2 adds the world-model tables and
-- part 3 adds row-level security.

create schema if not exists extensions;
create schema if not exists vault;

create extension if not exists pgcrypto;
create extension if not exists supabase_vault with schema vault;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);

-- Per-project LLM-provider credentials. Values live in Supabase Vault; this
-- table stores the metadata handle. The name whitelist mirrors
-- explabs.secrets.ProjectSecretName and must stay in sync with
-- upsert_project_secret below.
create table public.project_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (
    name in (
      'anthropic_api_key',
      'openai_api_key',
      'aws_access_key_id',
      'aws_secret_access_key',
      'aws_region',
      'azure_openai_api_key',
      'azure_openai_endpoint'
    )
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

create unique index project_secrets_active_project_name
  on public.project_secrets (project_id, name)
  where revoked_at is null;

-- Covering indexes for the org/project cascade FKs; the partial unique index
-- above excludes revoked rows, so it cannot serve FK cascade scans.
create index project_secrets_org_id_idx
  on public.project_secrets (org_id);

create index project_secrets_project_id_idx
  on public.project_secrets (project_id);

grant select, insert, update, delete on public.project_secrets to service_role;

-- Canonical metadata for built world-model bundles (and future heavy
-- platform assets) stored in Supabase Storage. Storage is the source of
-- truth for the bytes; each row records where a bundle lives plus integrity
-- metadata. explabs/db/stores/artifact_store.py reads every column below, so
-- this shape is a stable contract. The `world_model_id` link column is added
-- in part 2, after public.world_models exists.
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Seeded with 'world_model_bundle'; plain text rather than an enum so new
  -- asset kinds land without a migration.
  kind text not null,
  storage_bucket text not null default 'explabs-artifacts',
  storage_path text not null unique,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null,
  created_at timestamptz not null default now()
);

create index artifacts_project_kind_idx
  on public.artifacts (project_id, kind, created_at desc);

-- Covering index for the org cascade FK.
create index artifacts_org_id_idx
  on public.artifacts (org_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'explabs-artifacts',
  'explabs-artifacts',
  false,
  52428800,
  array[
    'application/json',
    'application/x-ndjson',
    'application/gzip',
    'application/octet-stream',
    'text/plain',
    'text/markdown'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Project secret management. These run as the table owner so the service role
-- can read and write Vault-encrypted secrets without direct Vault grants.
-- Every security-definer function pins `search_path = ''` and fully
-- schema-qualifies every reference.
create or replace function public.upsert_project_secret(
  in_project_id uuid,
  in_name text,
  in_secret text,
  in_updated_by text default null,
  in_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  org_id uuid,
  project_id uuid,
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
  normalized_name text := lower(nullif(btrim(in_name), ''));
  actor text := nullif(btrim(in_updated_by), '');
  vault_secret uuid;
  existing_vault_secret uuid;
  vault_name text;
  value_last4 text;
begin
  if in_project_id is null then
    raise exception 'project_id is required';
  end if;
  if normalized_name is null then
    raise exception 'secret name is required';
  end if;
  if normalized_name not in (
    'anthropic_api_key',
    'openai_api_key',
    'aws_access_key_id',
    'aws_secret_access_key',
    'aws_region',
    'azure_openai_api_key',
    'azure_openai_endpoint'
  ) then
    raise exception 'unsupported project secret name: %', normalized_name;
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'secret value is required';
  end if;

  select projects.org_id
  into target_org_id
  from public.projects
  where projects.id = in_project_id;

  if target_org_id is null then
    raise exception 'project not found: %', in_project_id;
  end if;

  select secrets.id, secrets.vault_secret_id
  into existing_secret_id, existing_vault_secret
  from public.project_secrets secrets
  where secrets.project_id = in_project_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null
  limit 1;

  value_last4 := right(in_secret, 4);
  vault_name := format(
    'project:%s:secret:%s:%s',
    in_project_id::text,
    normalized_name,
    gen_random_uuid()::text
  );
  if existing_secret_id is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_name);

    insert into public.project_secrets (
      org_id,
      project_id,
      name,
      vault_secret_id,
      last4,
      created_by,
      updated_by,
      metadata
    )
    values (
      target_org_id,
      in_project_id,
      normalized_name,
      vault_secret,
      value_last4,
      actor,
      actor,
      coalesce(in_metadata, '{}'::jsonb)
    )
    returning project_secrets.id into existing_secret_id;
  else
    perform vault.update_secret(existing_vault_secret, in_secret, vault_name, normalized_name);

    update public.project_secrets
    set
      last4 = value_last4,
      updated_by = actor,
      updated_at = now(),
      rotated_at = now(),
      metadata = coalesce(in_metadata, '{}'::jsonb)
    where project_secrets.id = existing_secret_id;
  end if;

  return query
    select
      secrets.id,
      secrets.org_id,
      secrets.project_id,
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
    from public.project_secrets secrets
    where secrets.id = existing_secret_id;
end;
$$;

create or replace function public.get_project_secret(
  in_project_id uuid,
  in_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := lower(nullif(btrim(in_name), ''));
  vault_secret uuid;
  secret_value text;
begin
  if in_project_id is null or normalized_name is null then
    raise exception 'project_id and secret name are required';
  end if;

  select secrets.vault_secret_id
  into vault_secret
  from public.project_secrets secrets
  where secrets.project_id = in_project_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null
  limit 1;

  if vault_secret is null then
    return null;
  end if;

  select decrypted.decrypted_secret
  into secret_value
  from vault.decrypted_secrets decrypted
  where decrypted.id = vault_secret
  limit 1;

  update public.project_secrets secrets
  set last_used_at = now()
  where secrets.project_id = in_project_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null;

  return secret_value;
end;
$$;

create or replace function public.list_project_secrets(in_project_id uuid)
returns table (
  name text,
  value text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if in_project_id is null then
    raise exception 'project_id is required';
  end if;

  -- Stamp last_used_at only on rows whose Vault entry resolves, so the
  -- access record never claims a "use" for a secret the caller never got
  -- (e.g. an orphaned vault_secret_id).
  update public.project_secrets secrets
  set last_used_at = now()
  where secrets.project_id = in_project_id
    and secrets.revoked_at is null
    and exists (
      select 1
      from vault.decrypted_secrets decrypted
      where decrypted.id = secrets.vault_secret_id
    );

  return query
    select
      secrets.name,
      decrypted.decrypted_secret as value
    from public.project_secrets secrets
    join vault.decrypted_secrets decrypted
      on decrypted.id = secrets.vault_secret_id
    where secrets.project_id = in_project_id
      and secrets.revoked_at is null;
end;
$$;

create or replace function public.list_project_secret_metadata(in_project_id uuid)
returns table (
  id uuid,
  org_id uuid,
  project_id uuid,
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
    secrets.org_id,
    secrets.project_id,
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
  from public.project_secrets secrets
  where secrets.project_id = in_project_id
    and secrets.revoked_at is null
  order by secrets.name;
$$;

revoke all on function public.upsert_project_secret(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_project_secret(uuid, text)
  from public, anon, authenticated;
revoke all on function public.list_project_secrets(uuid)
  from public, anon, authenticated;
revoke all on function public.list_project_secret_metadata(uuid)
  from public, anon, authenticated;

grant execute on function public.upsert_project_secret(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.get_project_secret(uuid, text)
  to service_role;
grant execute on function public.list_project_secrets(uuid)
  to service_role;
grant execute on function public.list_project_secret_metadata(uuid)
  to service_role;

-- updated_at maintenance.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

-- Signup tenant provisioning: every new auth user lands in an organization.
--
-- Resolution is a precedence chain so future joining mechanisms slot in
-- without restructuring: invite-based joins (org_invitations) and verified
-- domain joins (org_domains) will be checked first once those tables exist;
-- today only the fallback branch -- create a personal org owned by the user
-- -- is implemented. Seed sessions are exempt: they set the
-- `explabs.seed_admin_email` GUC and grant memberships explicitly.
create or replace function public.provision_signup_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_org_id uuid;
  email_local text;
  org_slug text;
begin
  -- Seeded users (local stack, previews, CI) receive explicit memberships
  -- from seed.sql; skip personal-org creation for them.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

  -- Precedence chain: invite -> domain -> personal org. The first two
  -- branches land with their tables; only the fallback exists today.
  email_local := lower(
    coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'user')
  );
  -- The uuid prefix keeps slugs unique per user; collisions would need two
  -- users sharing an email local part and the same first 8 uuid hex chars.
  org_slug := regexp_replace(email_local, '[^a-z0-9]+', '-', 'g')
    || '-' || left(new.id::text, 8);

  insert into public.organizations (slug, name)
  values (org_slug, email_local)
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, new.id, 'owner');

  return new;
end;
$$;

-- auth.users is owned by GoTrue and does not exist yet when migrations run
-- on a fresh Docker stack (GoTrue boots after supabase-migrate). This helper
-- is idempotent; seed.sql re-invokes it once auth.users exists. On Supabase
-- CLI and hosted branches auth.users predates migrations, so the call below
-- attaches the trigger immediately.
create or replace function public.ensure_signup_org_trigger()
returns void
language plpgsql
as $$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users does not exist yet; signup org trigger deferred to seed';
    return;
  end if;
  drop trigger if exists provision_signup_org on auth.users;
  create trigger provision_signup_org
    after insert on auth.users
    for each row execute function public.provision_signup_org();
end;
$$;

-- Same call surface as the secret RPCs above: the owner (migration/seed role)
-- and service_role only; never client roles.
revoke all on function public.ensure_signup_org_trigger()
  from public, anon, authenticated;
grant execute on function public.ensure_signup_org_trigger()
  to service_role;

select public.ensure_signup_org_trigger();

create index organization_members_user_id_idx
  on public.organization_members (user_id);

create index projects_org_id_idx
  on public.projects (org_id);
