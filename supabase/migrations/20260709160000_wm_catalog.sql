-- Shared world-model catalog: one platform-global storage of importable,
-- already-built world models, with per-user likes and download metering.
--
-- Entries are org-agnostic and fully self-contained: each row owns its bundle
-- metadata inline (bucket/path/byte_size/sha256) and its bytes live once in
-- the shared artifacts bucket at the content-addressed
-- catalog/{entry_id}/{sha256}.tar.gz (a concurrent writer can never leave a
-- row pointing at someone else's bytes). Entries deliberately do NOT
-- reference the tenant-scoped public.artifacts table: artifacts rows cascade
-- away with their owning org/project, which would silently brick every
-- project that imported the entry.
--
-- An entry may also carry its trace corpus, stored once under the entry's
-- catalog/{entry_id}/traces/ prefix. Importing such an entry clones a
-- trace_uploads row pointing at the shared object (the
-- provision_starter_examples pattern: nothing deletes storage objects and
-- trace bytes are only read through the service role), so imported models
-- can be REBUILT; a successful rebuild graduates the model (the build result
-- sets artifact_id and clears catalog_entry_id in one statement).
--
-- Entries are immutable once published; retirement is a soft deprecation
-- (deprecated_at) that hides the entry from listing and blocks new imports
-- while existing imports keep serving the pinned bundle. import_count is a
-- cumulative download counter (re-imports count again, deletions never
-- decrement) metering the catalog ordering; it is deliberately NOT a
-- distinct-org endorsement signal.

create table public.wm_catalog_entries (
  id uuid primary key default gen_random_uuid(),
  -- Default world-model name on import; same wmh slug rule as world_models
  -- (the name doubles as an on-disk directory name in importing projects).
  name text not null check (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  display_name text,
  description text,
  -- Serve/embed configuration copied verbatim onto imported world_models
  -- rows. serve_provider/serve_model are NOT NULL: an entry is by definition
  -- servable because it is published from a ready, built world model.
  serve_provider text not null,
  serve_model text not null,
  embed_provider text,
  embed_dim integer check (embed_dim is null or embed_dim > 0),
  trace_adapter text not null default 'otel-genai',
  config jsonb not null default '{}'::jsonb,
  -- Build metrics snapshotted from the source model so the import dialog and
  -- imported rows can show real fidelity numbers.
  metrics jsonb,
  -- Corpus shape of the bundle's replay buffer, when known (the example
  -- provisioner records it from the offline build's ingest counts).
  trace_count integer check (trace_count is null or trace_count >= 0),
  step_count integer check (step_count is null or step_count >= 0),
  -- Canonical bundle object, owned by the entry. Storage is the source of
  -- truth for the bytes; these columns are the integrity-bearing pointer.
  storage_bucket text not null default 'explabs-artifacts',
  storage_path text not null unique,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null,
  -- Cumulative successful imports ("downloads"); bumped by the import fence
  -- trigger below in the same transaction as the importing insert.
  import_count bigint not null default 0 check (import_count >= 0),
  -- The entry's trace corpus, when it carries one: all-or-nothing so a
  -- partially populated pointer (path without digest) is a schema error.
  traces_filename text,
  traces_storage_path text unique,
  traces_byte_size bigint check (traces_byte_size is null or traces_byte_size >= 0),
  traces_sha256 text,
  -- Provenance only: the entry must outlive its source model and org.
  source_world_model_id uuid references public.world_models(id) on delete set null,
  deprecated_at timestamptz,
  created_at timestamptz not null default now(),
  constraint wm_catalog_entries_traces_all_or_nothing check (
    num_nonnulls(traces_filename, traces_storage_path, traces_byte_size, traces_sha256)
      in (0, 4)
  )
);

-- One live entry per name; deprecated entries free their name for an
-- improved re-publish while staying importable-nowhere and pinned forever
-- for rows that already imported them.
create unique index wm_catalog_entries_live_name_key
  on public.wm_catalog_entries (name)
  where deprecated_at is null;

create index wm_catalog_entries_created_idx
  on public.wm_catalog_entries (created_at desc);

-- Covering index for the provenance FK.
create index wm_catalog_entries_source_world_model_idx
  on public.wm_catalog_entries (source_world_model_id);

-- Service-role only, like the platform's other control-plane tables: RLS on
-- with no policies means anon/authenticated read nothing; the FastAPI
-- backend (service role, bypasses RLS) is the single reader/writer.
alter table public.wm_catalog_entries enable row level security;

-- Per-user likes. user_id mirrors organization_members.user_id: a GoTrue
-- auth.users id without a declared FK (auth.users is GoTrue-owned and may
-- not exist during migrations).
create table public.wm_catalog_entry_likes (
  entry_id uuid not null references public.wm_catalog_entries(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);

-- Reverse lookup: the entries a user has liked (liked_by_me across a list).
create index wm_catalog_entry_likes_user_idx
  on public.wm_catalog_entry_likes (user_id);

alter table public.wm_catalog_entry_likes enable row level security;

-- A world model's bundle comes from exactly one source: its own build
-- (artifact_id) or a catalog import (catalog_entry_id). RESTRICT keeps a
-- referenced entry undeletable so imports can never brick; retirement is the
-- soft deprecation above.
alter table public.world_models
  add column catalog_entry_id uuid references public.wm_catalog_entries(id) on delete restrict,
  add constraint world_models_bundle_source_exclusive
    check (artifact_id is null or catalog_entry_id is null);

-- Covering index for the catalog FK.
create index world_models_catalog_entry_id_idx
  on public.world_models (catalog_entry_id);

-- Import fence + download meter, in one statement. The import route
-- pre-checks deprecated_at, but a deprecate can commit between that read and
-- the insert; the conditional UPDATE takes the entry's row lock, so it
-- serializes against a concurrent deprecate — whichever commits first
-- decides — and a fenced-out import raises the check-violation class (23514)
-- the route maps to a typed 422. The same UPDATE meters the download, so the
-- count moves exactly when an import commits and rolls back with it.
-- (A read-lock-then-update split here would deadlock two concurrent imports
-- of one entry; the single UPDATE cannot.)
create or replace function public.count_catalog_import()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.catalog_entry_id is not null then
    update public.wm_catalog_entries
       set import_count = import_count + 1
     where id = new.catalog_entry_id
       and deprecated_at is null;
    if not found then
      raise exception 'catalog entry % is deprecated and closed to new imports',
        new.catalog_entry_id
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger world_models_count_catalog_import
before insert on public.world_models
for each row execute function public.count_catalog_import();

-- Like tallies for a set of entries, aggregated in the database: the backend
-- would otherwise fetch raw like rows and silently undercount once a
-- listing's likes exceed PostgREST's max-rows cap. Service-role only, like
-- the platform's other control-plane functions.
create or replace function public.catalog_like_counts(in_entry_ids uuid[])
returns table (entry_id uuid, like_count bigint)
language sql
stable
set search_path = ''
as $$
  select likes.entry_id, count(*)::bigint as like_count
    from public.wm_catalog_entry_likes likes
   where likes.entry_id = any(in_entry_ids)
   group by likes.entry_id;
$$;

revoke all on function public.catalog_like_counts(uuid[])
  from public, anon, authenticated;
grant execute on function public.catalog_like_counts(uuid[]) to service_role;
