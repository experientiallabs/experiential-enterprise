#!/usr/bin/env bash
set -euo pipefail

database_url="${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"
postgres_password="${POSTGRES_PASSWORD:-postgres}"
admin_email="${EXPLABS_AUTH_ADMIN_EMAIL:-admin@xplabs.ai}"
admin_password="${EXPLABS_AUTH_ADMIN_PASSWORD:-3XP321!}"

/app/docker/supabase/wait-for-postgres.sh "${database_url}" 120

psql "${database_url}" \
  -v ON_ERROR_STOP=1 \
  -v db_password="${postgres_password}" <<'SQL'
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin nologin superuser createrole createdb replication bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login;
  end if;
end
$$;

alter role authenticator with password :'db_password';
alter role supabase_admin
  with login password :'db_password' superuser createrole createdb replication bypassrls;
grant anon, authenticated, service_role to authenticator;
grant pg_read_server_files to supabase_admin;
create schema if not exists _realtime authorization supabase_admin;
create schema if not exists realtime authorization supabase_admin;

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('auth.users') is not null
    and not exists (
      select 1
      from information_schema.columns
      where table_schema = 'auth'
        and table_name = 'users'
        and column_name = 'instance_id'
    )
  then
    drop table auth.users cascade;
  end if;
end
$$;

-- PostgREST v12 dropped the legacy per-claim GUCs (request.jwt.claim.sub),
-- so prefer the JSON claims object and keep the legacy form as fallback,
-- mirroring auth.jwt() below. Hosted Supabase ships this behavior already;
-- only this local definition read the legacy GUC alone, which made
-- auth.uid() NULL on every request and silently failed the RLS policies
-- built on it (user_onboarding).
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select case
    when nullif(current_setting('request.jwt.claims', true), '') is not null
      then current_setting('request.jwt.claims', true)::jsonb
    else jsonb_build_object(
      'role', nullif(current_setting('request.jwt.claim.role', true), ''),
      'sub', nullif(current_setting('request.jwt.claim.sub', true), '')
    )
  end;
$$;

do $$
begin
  create type auth.factor_type as enum ('totp', 'webauthn');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type auth.factor_status as enum ('unverified', 'verified');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
exception
  when duplicate_object then null;
end
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  public boolean not null default false,
  avif_autodetection boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz,
  metadata jsonb,
  unique (bucket_id, name)
);

create table if not exists public.explabs_schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

grant usage on schema public, auth, storage to anon, authenticated, service_role;

-- Match hosted Supabase's baseline object grants before application migrations
-- run. Migrations remain authoritative and can narrow these defaults without a
-- later bootstrap step accidentally restoring direct table access.
alter default privileges in schema public, auth, storage
  grant all privileges on tables to service_role;
alter default privileges in schema public, auth, storage
  grant all privileges on sequences to service_role;
alter default privileges in schema public, auth, storage
  grant select on tables to authenticated;
alter default privileges in schema public, auth, storage
  grant select on tables to anon;

do $bootstrap_grants$
begin
  if not exists (select 1 from public.explabs_schema_migrations) then
    execute 'grant all privileges on all tables in schema public, auth, storage to service_role';
    execute 'grant all privileges on all sequences in schema public, auth, storage to service_role';
    execute 'grant select on all tables in schema public, auth, storage to authenticated';
    execute 'grant select on all tables in schema public, auth, storage to anon';
  end if;
end
$bootstrap_grants$;
SQL

for migration in /app/supabase/migrations/*.sql; do
  version="$(basename "${migration}")"
  applied="$(
    psql "${database_url}" -v ON_ERROR_STOP=1 -tAc \
      "select exists(select 1 from public.explabs_schema_migrations where version = '${version}')"
  )"
  if [ "${applied}" = "t" ]; then
    echo "Skipping applied migration ${version}"
    continue
  fi
  echo "Applying migration ${version}"
  psql "${database_url}" -v ON_ERROR_STOP=1 -f "${migration}"
  psql "${database_url}" -v ON_ERROR_STOP=1 -c \
    "insert into public.explabs_schema_migrations (version) values ('${version}')"
done

echo "Applying seed data"
psql "${database_url}" \
  -v ON_ERROR_STOP=1 \
  -v explabs_admin_email="${admin_email}" \
  -v explabs_admin_password="${admin_password}" \
  -v ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -v OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  -v OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
  -v GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
  -v FIREWORKS_API_KEY="${FIREWORKS_API_KEY:-}" \
  -v AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}" \
  -v AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}" \
  -v AWS_REGION="${AWS_REGION:-}" \
  -v AZURE_OPENAI_API_KEY="${AZURE_OPENAI_API_KEY:-}" \
  -v AZURE_OPENAI_ENDPOINT="${AZURE_OPENAI_ENDPOINT:-}" \
  -v EXPLABS_GATEWAY_LEGACY_SERVING_BASE_URL="${EXPLABS_GATEWAY_LEGACY_SERVING_BASE_URL:-}" <<'SQL'
select
  set_config('explabs.seed_admin_email', :'explabs_admin_email', false),
  set_config('explabs.seed_admin_password', :'explabs_admin_password', false)
\g /dev/null
\i /app/supabase/seed.sql
\i /app/supabase/seed-secrets.sql
\i /app/supabase/seed-gateway-catalog.sql
\i /app/supabase/seed-demo-account.sql
SQL

psql "${database_url}" -v ON_ERROR_STOP=1 \
  -c "notify pgrst, 'reload schema'"

echo "Supabase schema and seed are ready"
