-- Experiential Labs world-model platform schema, part 3 of 3: row-level
-- security.
--
-- Trusted rows are written by the service role (which bypasses RLS). Browser
-- clients authenticate as `authenticated` and may only read rows belonging to
-- an organization they are a member of.

-- Resolves the current user from either the flattened `request.jwt.claim.sub`
-- GUC or the JSON `request.jwt.claims` blob, then returns every organization
-- the user belongs to. Policies consume this through an uncorrelated
-- `(select public.member_org_ids())` subquery so the planner evaluates the
-- membership lookup once per statement (an initplan/hashed subplan) instead of
-- re-invoking a membership check per candidate row.
create or replace function public.member_org_ids()
returns setof uuid
language sql
security definer
set search_path = ''
stable
as $$
  select members.org_id
  from public.organization_members members
  where members.user_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

-- `member_org_ids` is invoked inside the RLS policies below, so the
-- `authenticated` role must keep execute. Supabase's default privileges grant
-- EXECUTE directly to anon/authenticated (plus PUBLIC) on every new function,
-- which is what exposes this definer-rights helper to the anon API role. Strip
-- all of those and grant execute back only to the roles that need it; anon
-- never has a membership claim and is granted no rows, so it never needs to
-- call this function.
revoke all on function public.member_org_ids() from public, anon, authenticated;
grant execute on function public.member_org_ids() to authenticated, service_role;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table public.project_secrets enable row level security;
alter table public.artifacts enable row level security;
alter table public.world_models enable row level security;
alter table public.trace_uploads enable row level security;
alter table public.build_jobs enable row level security;
alter table public.wm_sessions enable row level security;
alter table public.wm_steps enable row level security;

create policy organizations_select_member
  on public.organizations
  for select
  to authenticated
  using (id in (select public.member_org_ids()));

create policy organization_members_select_member
  on public.organization_members
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create policy projects_select_member
  on public.projects
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create policy project_secrets_service_role_rw
  on public.project_secrets
  for all
  to service_role
  using (true)
  with check (true);

create policy artifacts_select_member
  on public.artifacts
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create policy world_models_select_member
  on public.world_models
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create policy trace_uploads_select_member
  on public.trace_uploads
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- build_jobs carries no org_id; it reaches its organization through its
-- world model. The membership subquery stays uncorrelated so it still runs
-- once per statement.
create policy build_jobs_select_member
  on public.build_jobs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.world_models models
      where models.id = build_jobs.world_model_id
        and models.org_id in (select public.member_org_ids())
    )
  );

create policy wm_sessions_select_member
  on public.wm_sessions
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- wm_steps carries no org_id; it reaches its organization through its
-- session. The membership subquery stays uncorrelated so it still runs once
-- per statement.
create policy wm_steps_select_member
  on public.wm_steps
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.wm_sessions sessions
      where sessions.id = wm_steps.wm_session_id
        and sessions.org_id in (select public.member_org_ids())
    )
  );

create policy storage_objects_explabs_artifacts_member_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'explabs-artifacts'
    and exists (
      select 1
      from public.artifacts artifacts
      where artifacts.storage_bucket = storage.objects.bucket_id
        and artifacts.storage_path = storage.objects.name
        and artifacts.org_id in (select public.member_org_ids())
    )
  );
