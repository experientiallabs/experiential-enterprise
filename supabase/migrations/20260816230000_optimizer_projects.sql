-- Customer-facing optimizer Projects are product records beneath an organization.
-- They are deliberately not the historical Project-as-workspace tenancy layer
-- removed by 20260710120000_org_only_workspaces.sql: organizations remain the
-- only membership and permission boundary.

create table public.optimizer_projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  display_name text not null check (
    char_length(btrim(display_name)) between 1 and 100
  ),
  description text check (
    description is null or char_length(description) <= 2000
  ),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimizer_projects_org_slug_key unique (org_id, slug)
);

comment on table public.optimizer_projects is
  'Organization-owned WMO product Projects. Not a tenancy or membership boundary.';
comment on column public.optimizer_projects.archived_at is
  'Non-null after non-destructive archive; archive never deletes legacy product rows.';

-- Default lists read one org's active Projects newest-first. The unique index
-- above already covers unrestricted org + slug lookups.
create index optimizer_projects_org_active_created_idx
  on public.optimizer_projects (org_id, created_at desc, id desc)
  where archived_at is null;

alter table public.optimizer_projects enable row level security;

-- Match the current Platform control-plane pattern: authenticated clients may
-- read their organizations through RLS; writes have no authenticated policy and
-- go through the role-gated FastAPI service-role store.
create policy optimizer_projects_select_member
  on public.optimizer_projects
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));
