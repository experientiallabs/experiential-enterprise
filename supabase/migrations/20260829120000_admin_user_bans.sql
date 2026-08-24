-- ---------------------------------------------------------------------------
-- Admin user bans.
--
-- Platform operators can ban an account from the admin panel. The enforcement
-- primitive is GoTrue's own `auth.users.banned_until`, which blocks EVERY
-- sign-in method — password, emailed code, and OAuth — and refuses token
-- refresh. GoTrue reads the column from the database on every auth decision
-- (it keeps no in-memory ban state), so record_user_ban/clear_user_ban write
-- it directly: the GoTrue lockout, the ban record, the key revocation, and
-- the session teardown all commit in ONE transaction, and a failure anywhere
-- rolls the whole ban back. No ordering can leave keys active on a
-- locked-out user or a signed-in user wearing a BANNED badge. This table is
-- the platform-side record of the ban: who banned, when, and why, so the
-- admin panel can list and filter banned accounts.
--
-- One row per ACTIVELY banned user, mirroring platform_admins: banning
-- upserts the row, unbanning deletes it. There is no ban history table — the
-- live record's who/when/reason is the audit trail (the house pattern is
-- provenance columns on the record itself; no audit-log mechanism exists).
--
-- Banning also cuts off what a live login already holds, atomically in
-- public.record_user_ban:
--   * every API key the user MINTED is revoked (`created_by`, per-user and
--     cross-org — the predicate from 20260823010000_rotate_credentials_on_verify:
--     personal keys only, so banning one member NEVER revokes keys other
--     members created for the same org). If the banned user is the sole
--     member of an org, that org's gateway access effectively stops with
--     their keys — accepted: there is no one legitimate left to serve.
--   * every GoTrue session of the user is deleted (auth.refresh_tokens rows
--     cascade with their session), so refresh dies immediately. The already
--     issued access token stays valid until its JWT expiry — the web proxy
--     verifies claims locally — which is the accepted residual window;
--     `banned_until` guarantees no new token is ever minted.
-- Unban restores sign-in only. Revoked keys STAY revoked (revocation is
-- one-way everywhere in this schema); the user mints fresh keys after unban.
-- ---------------------------------------------------------------------------

create table public.user_bans (
  -- GoTrue owns auth.users and local Docker migrates before GoTrue creates
  -- it, so deliberately no FK; cleanup_deleted_auth_user removes the row.
  user_id uuid primary key,
  reason text not null check (length(trim(reason)) between 1 and 500),
  banned_by uuid,
  banned_at timestamptz not null default now()
);

comment on table public.user_bans is
  'Actively banned auth users: who banned, when, why. Enforcement lives in auth.users.banned_until; unban deletes the row.';

alter table public.user_bans enable row level security;

-- Platform operators read the roster under their own RLS session (the admin
-- Users page loads through the viewer's session, like orgs/platform_admins);
-- all writes go through the service role.
create policy user_bans_select_admin on public.user_bans
  for select to authenticated
  using (public.is_platform_admin());

grant select on public.user_bans to authenticated;
grant select, insert, update, delete on public.user_bans to service_role;

-- ---------------------------------------------------------------------------
-- record_user_ban: the whole ban in one transaction — GoTrue lockout
-- (banned_until, effectively permanent at 100 years, the same horizon the
-- Supabase admin API's ban_duration writes), the ban record, key revocation,
-- and session teardown. Atomic on purpose: a partially applied ban is either
-- a locked-out user whose keys still serve gateway traffic or an active
-- account wearing a BANNED badge, and neither may exist even transiently.
-- ---------------------------------------------------------------------------

create or replace function public.record_user_ban(
  in_user_id uuid,
  in_banned_by uuid,
  in_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_bans (user_id, reason, banned_by)
  values (in_user_id, in_reason, in_banned_by)
  on conflict (user_id) do update
    set reason = excluded.reason,
        banned_by = excluded.banned_by,
        banned_at = pg_catalog.now();

  -- Personal keys only: created_by scoping (see 20260823010000) never touches
  -- keys other members minted, in this or any other org.
  update public.api_keys
     set revoked_at = pg_catalog.now()
   where created_by = in_user_id
     and revoked_at is null;

  -- Local Docker migrates before GoTrue creates its tables; on hosted
  -- Supabase the auth schema always exists. GoTrue consults banned_until on
  -- every token grant, refresh, and OTP verify, so this write IS the lockout.
  -- Deleting the sessions cascades the refresh tokens, so the banned user
  -- cannot outlive their current access token's JWT expiry.
  if pg_catalog.to_regclass('auth.users') is not null then
    update auth.users
       set banned_until = pg_catalog.now() + interval '876000 hours',
           updated_at = pg_catalog.now()
     where id = in_user_id;
  end if;
  if pg_catalog.to_regclass('auth.sessions') is not null then
    delete from auth.sessions where user_id = in_user_id;
  end if;
end;
$$;

revoke all on function public.record_user_ban(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_user_ban(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- clear_user_ban: the whole unban in one transaction — clears banned_until
-- and removes the record together, so the roster and the lockout can never
-- disagree. Idempotent: unbanning an account that is not banned is a no-op.
-- Keys revoked at ban time stay revoked (revocation is one-way everywhere in
-- this schema); the user mints fresh keys after unban.
-- ---------------------------------------------------------------------------

create or replace function public.clear_user_ban(in_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.user_bans where user_id = in_user_id;
  if pg_catalog.to_regclass('auth.users') is not null then
    update auth.users
       set banned_until = null,
           updated_at = pg_catalog.now()
     where id = in_user_id
       and banned_until is not null;
  end if;
end;
$$;

revoke all on function public.clear_user_ban(uuid) from public, anon, authenticated;
grant execute on function public.clear_user_ban(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- admin_list_users: the admin Users page roster. Joins auth emails and
-- sign-in/ban state the way admin_list_org_members does for org rosters —
-- a definer RPC because PostgREST cannot see the auth schema. plpgsql, not
-- sql, so a fresh local stack can create it before GoTrue makes auth.users.
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz,
  ban_reason text,
  banned_by uuid,
  banned_by_email text,
  banned_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin required';
  end if;
  return query
    select users.id,
           users.email::text,
           users.created_at,
           users.last_sign_in_at,
           users.banned_until,
           bans.reason,
           bans.banned_by,
           banners.email::text,
           bans.banned_at
      from auth.users users
      left join public.user_bans bans on bans.user_id = users.id
      left join auth.users banners on banners.id = bans.banned_by
     order by users.created_at desc;
end;
$$;

revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deleting the auth user removes their ban record (same body as
-- 20260711150000_admin_deletion_cascades plus the two user_bans lines; the
-- trigger keeps pointing at this name).
-- ---------------------------------------------------------------------------

create or replace function public.cleanup_deleted_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.organization_members where user_id = old.id;
  delete from public.platform_admins where user_id = old.id;
  update public.platform_admins set granted_by = null where granted_by = old.id;

  delete from public.user_bans where user_id = old.id;
  update public.user_bans set banned_by = null where banned_by = old.id;

  -- Remove the deleted account's own invite history so the address can be
  -- invited again. Invites created for other people remain useful but lose
  -- the deleted operator provenance.
  delete from public.org_invitations
   where accepted_by = old.id
      or (old.email is not null and lower(email) = lower(old.email));
  update public.org_invitations set invited_by = null where invited_by = old.id;

  delete from public.wm_catalog_entry_likes where user_id = old.id;
  delete from public.user_onboarding where user_id = old.id;
  delete from public.agent_session_commands where actor_id = old.id;

  -- These resources belong to organizations, not their original creator.
  -- Preserve them while removing the stale auth-user pointer.
  update public.api_keys set created_by = null where created_by = old.id;
  update public.harnesses set created_by = null where created_by = old.id;
  update public.harness_versions set created_by = null where created_by = old.id;
  update public.agent_sessions set created_by = null where created_by = old.id;

  return old;
end;
$$;

revoke all on function public.cleanup_deleted_auth_user() from public, anon, authenticated;
