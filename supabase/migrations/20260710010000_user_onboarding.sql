-- Per-user onboarding completion.
--
-- A `user_onboarding` row means the user has finished (or skipped) the
-- first-run onboarding flow: the guided catalog import plus the harness
-- optimization demo. The web app's root redirector sends users without a row
-- to /onboarding on sign-in. Users write their own row exactly once — the
-- flow is per-user, not per-org, so an invitee joining an existing org still
-- sees it on first sign-in.
--
-- No FK to auth.users: GoTrue owns that table and it does not exist yet when
-- migrations run on a fresh Docker stack (see 20260703120000_types_and_core).
-- Like organization_members.user_id, the id is trusted from the verified JWT;
-- a row orphaned by user deletion is inert.

create table public.user_onboarding (
  user_id uuid primary key,
  completed_at timestamptz not null default now()
);

alter table public.user_onboarding enable row level security;

create policy user_onboarding_select_own
  on public.user_onboarding
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy user_onboarding_insert_own
  on public.user_onboarding
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));
