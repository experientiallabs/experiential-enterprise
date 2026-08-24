-- Experiential Labs world-model platform schema: the harness registry.
--
-- A registry harness is a named, versioned wmh HarnessDoc that CLI users
-- publish (`wmh push`) and fetch (`wmh pull`) under a project. The doc JSON
-- in the database is canonical — versions render deterministically to wmh's
-- bundle file layout on demand, so nothing is stored in object storage.
-- Registry harnesses are user-published artifacts, deliberately separate from
-- the optimizer-owned lineage the hosted-agents feature keeps per agent.

create table public.harnesses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- wmh harness slug; doubles as the on-disk directory name under
  -- .wmh/harnesses/ when pulled, so it must stay filesystem- and URL-safe.
  name text not null check (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  display_name text,
  -- Highest published version; 0 until the first push lands.
  latest_version integer not null default 0 check (latest_version >= 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create trigger harnesses_set_updated_at
before update on public.harnesses
for each row execute function public.set_updated_at();

create index harnesses_org_id_idx
  on public.harnesses (org_id);

create index harnesses_project_created_idx
  on public.harnesses (project_id, created_at desc);

-- Append-only version lineage. The registry never rewrites a version: a
-- re-push of the latest doc is a no-op, and pushing an older doc again
-- creates a fresh version (rollback-by-repush keeps history linear).
create table public.harness_versions (
  id uuid primary key default gen_random_uuid(),
  harness_id uuid not null references public.harnesses(id) on delete cascade,
  version integer not null check (version >= 1),
  -- Canonical wmh HarnessDoc dump; validated against wmh's schema and
  -- re-hashed server-side before insert.
  doc jsonb not null,
  -- wmh doc identity: blake2b-128 hex over the sorted surface hashes.
  doc_hash text not null check (doc_hash ~ '^[0-9a-f]{32}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (harness_id, version)
);

create index harness_versions_harness_version_idx
  on public.harness_versions (harness_id, version desc);

alter table public.harnesses enable row level security;
alter table public.harness_versions enable row level security;

-- Org members read their org's harnesses; writes go through the backend on
-- the service role, which enforces member-strength tenancy per request.
create policy harnesses_select_member
  on public.harnesses
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create policy harness_versions_select_member
  on public.harness_versions
  for select
  to authenticated
  using (exists (
    select 1
    from public.harnesses h
    where h.id = harness_versions.harness_id
      and h.org_id in (select public.member_org_ids())
  ));

grant select on public.harnesses to authenticated;
grant select on public.harness_versions to authenticated;
grant select, insert, update, delete on public.harnesses to service_role;
grant select, insert, update, delete on public.harness_versions to service_role;

-- CLI-pushed world-model bundles carry retrieval indexes (embeddings.npy)
-- that outgrow the original 50MB cap on large trace corpora; bundle bytes
-- move over signed URLs, so the API never buffers them either way.
update storage.buckets
set file_size_limit = 1073741824
where id = 'explabs-artifacts';
