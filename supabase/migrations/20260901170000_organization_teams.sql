-- Teams as first-class organization objects (design E4 item 1): a named group
-- of org members, plus nullable team_id ATTRIBUTION columns on api_keys and
-- gateway_identities.
--
-- This migration is DELIBERATELY ADDITIVE-ONLY. The attribution columns are
-- dimensions, not enforcement: nothing in the gateway hot path
-- (gateway_accept_request / gateway_start_attempt) reads team_id, and no
-- budget scope changes here. Team-scoped budgets and per-team usage rollups
-- arrive after PR #563 merges (it recreates gateway_start_attempt and renames
-- the 'team' budget scope literal); landing those dimensions now would
-- collide with that in-flight work for no product win.
--
-- Membership invariants live in the database, not just the API:
--   * a team member must already be a member of the team's organization
--     (BEFORE INSERT/UPDATE trigger against organization_members);
--   * removing someone's org membership removes their team memberships in
--     that org's teams (AFTER DELETE trigger on organization_members).

-- ---------------------------------------------------------------------------
-- 1. Teams. One row per named group; names are unique per org (case
--    sensitive, like gateway alias names). created_by is the admin who made
--    the team — informational, no FK, matching api_keys.created_by.

create table public.organization_teams (
  team_id    pg_catalog.uuid primary key default gen_random_uuid(),
  org_id     pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  name       pg_catalog.text not null
    check (pg_catalog.char_length(name) between 1 and 120),
  created_by pg_catalog.uuid,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (org_id, name)
);

comment on table public.organization_teams is
  'Named groups of organization members (design E4). Attribution target for api_keys.team_id and gateway_identities.team_id; budget scopes and usage rollups over team_id land after PR #563 merges.';

-- ---------------------------------------------------------------------------
-- 2. Team membership. People only (user_id mirrors organization_members,
--    which carries no FK to auth.users); machine principals attach through
--    gateway_identities.team_id instead.

create table public.organization_team_members (
  team_id    pg_catalog.uuid not null
    references public.organization_teams(team_id) on delete cascade,
  user_id    pg_catalog.uuid not null,
  added_by   pg_catalog.uuid,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (team_id, user_id)
);

comment on table public.organization_team_members is
  'Team rosters. Every member row is backed by an organization_members row in the team''s org (trigger-enforced); losing org membership cascades out of every team in that org.';

-- The org-membership cascade trigger deletes by (org's teams, user); the PK
-- only serves team-first lookups.
create index organization_team_members_user_idx
  on public.organization_team_members (user_id);

-- ---------------------------------------------------------------------------
-- 3. A team member must already be an org member. organization_members is the
--    source of truth for who is in the org; teams only subdivide it.

create function public.organization_team_member_org_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.organization_teams teams
      join public.organization_members members
        on members.org_id = teams.org_id
       and members.user_id = new.user_id
     where teams.team_id = new.team_id
  ) then
    raise exception 'user % is not a member of the team''s organization', new.user_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.organization_team_member_org_check()
  from public, anon, authenticated, service_role;

create trigger organization_team_members_org_check
  before insert or update on public.organization_team_members
  for each row execute function public.organization_team_member_org_check();

-- ---------------------------------------------------------------------------
-- 4. Org-membership deletion cascades team membership. Leaving (or being
--    removed from) the organization must not strand rows that claim a seat on
--    that org's teams.

create function public.organization_member_delete_team_cascade()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.organization_team_members team_members
   using public.organization_teams teams
   where team_members.team_id = teams.team_id
     and teams.org_id = old.org_id
     and team_members.user_id = old.user_id;
  return old;
end;
$$;

revoke all on function public.organization_member_delete_team_cascade()
  from public, anon, authenticated, service_role;

create trigger organization_members_team_cascade
  after delete on public.organization_members
  for each row execute function public.organization_member_delete_team_cascade();

-- ---------------------------------------------------------------------------
-- 5. Attribution columns. Nullable on purpose: a key or identity with no team
--    is the default, and deleting a team detaches rather than deletes what it
--    attributed. Columns only — no gateway hot-path read, no budget scope;
--    those dimensions arrive after PR #563 merges (header comment).

alter table public.api_keys
  add column team_id pg_catalog.uuid
    references public.organization_teams(team_id) on delete set null;

create index api_keys_team_id_idx on public.api_keys (team_id);

alter table public.gateway_identities
  add column team_id pg_catalog.uuid
    references public.organization_teams(team_id) on delete set null;

create index gateway_identities_team_id_idx on public.gateway_identities (team_id);

-- ---------------------------------------------------------------------------
-- 6. Row security and grants: newest-era posture (RLS on, zero policies,
--    revoke-all), like the identity tier's management tables. Only the
--    control API (service_role) touches teams; browser roles have no path.
--    api_keys.team_id inherits that table's existing member-readable select
--    grant, which is deliberate: a key's team attribution is not a secret.

alter table public.organization_teams enable row level security;
alter table public.organization_team_members enable row level security;

revoke all on table public.organization_teams
  from public, anon, authenticated, service_role;
revoke all on table public.organization_team_members
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.organization_teams to service_role;
grant select, insert, update, delete on table public.organization_team_members to service_role;
