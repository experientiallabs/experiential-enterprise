-- Per-user "has seen the signup-credit welcome greeting" signal.
--
-- A `user_credit_welcome` row means this user has already been shown the
-- sidebar credit greeting bubble once. The bubble used to pop on every
-- workspace visit until the org first spent (ledger-gated); the product owner wants it to
-- greet exactly once per user, then never again on any device or refresh. This
-- table is that durable once-ever flag: the row is written the first time the
-- bubble would render for the user, so a cleared cache or a second device can
-- never resurrect the greeting.
--
-- The signal is per-user, not per-org, so an invitee joining an existing org
-- still gets their own first greeting. Modeled on user_onboarding: no FK to
-- auth.users (GoTrue owns that table and it does not exist yet when migrations
-- run on a fresh Docker stack), the id is trusted from the verified JWT, and a
-- row orphaned by user deletion is inert because uuids are never reused. RLS
-- uses the house authenticated_user_id() helper (not raw auth.uid(), which
-- evaluates NULL on the local stack's GUC form) from the start.

create table public.user_credit_welcome (
  user_id uuid primary key,
  seen_at timestamptz not null default now()
);

alter table public.user_credit_welcome enable row level security;

-- The web tier reads-and-writes this table under the user's own RLS session,
-- so state the table privileges in the migration rather than leaning on hosted
-- default privileges: stacks without them silently broke user_onboarding's
-- upsert the same way. RLS still confines every row to its owner.
grant select, insert on public.user_credit_welcome to authenticated;

create policy user_credit_welcome_select_own
  on public.user_credit_welcome
  for select
  to authenticated
  using (user_id = public.authenticated_user_id());

create policy user_credit_welcome_insert_own
  on public.user_credit_welcome
  for insert
  to authenticated
  with check (user_id = public.authenticated_user_id());
