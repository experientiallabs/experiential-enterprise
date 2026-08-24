-- ---------------------------------------------------------------------------
-- Admin organization bans.
--
-- Platform operators can ban a whole tenant from the admin panel, mirroring
-- the per-user mechanics of 20260829120000_admin_user_bans. The enforcement
-- column is `organizations.banned_at`: the application layer refuses new API
-- key mints, new member invites, and domain-join approvals for a banned org,
-- and record_org_ban itself cuts off everything a live tenant already holds,
-- atomically in ONE transaction:
--   * every LIVE api_key of the org is revoked (org_id-scoped — the whole
--     tenant is banned, so unlike a user ban this deliberately includes keys
--     other members minted). Revocation is what stops /v1 serving: the
--     gateway worker authenticates every request against the key row.
--   * every pending org invite is revoked, so an invite link mailed before
--     the ban can no longer provision membership at signup.
--   * every CURRENT member is banned through public.record_user_ban — the
--     existing user-ban path — so sign-in and token refresh die and their
--     sessions are severed. Two deliberate exceptions: platform operators
--     are never swept (they are the recovery path, exactly as the org
--     deletion cascade preserves them), and a member who already carries an
--     INDIVIDUAL ban keeps that ban's provenance untouched.
--     user_bans.banned_via_org_id records which sweeps this org ban owns, so
--     unban can restore exactly the members it banned and nobody else.
--     NOTE: record_user_ban revokes the member's personal (created_by) keys
--     cross-org — accepted, because a banned USER may not hold live keys
--     anywhere (the user-ban invariant), and org-banning a member is banning
--     the user.
-- One row per ACTIVELY banned org in public.org_bans (who banned, when,
-- why), exactly the user_bans shape: banning upserts the row, unbanning
-- deletes it, the live record's provenance columns are the audit trail.
--
-- Unban (clear_org_ban) restores sign-in for the members THIS org ban swept
-- (unless they still belong to another banned org, in which case that ban
-- adopts them) and clears banned_at. Keys and invites revoked at ban time
-- STAY revoked — revocation is one-way everywhere in this schema; members
-- mint fresh keys and admins re-invite after unban.
--
-- NO EMAIL EVER FIRES: like user bans, these are direct SQL writes — GoTrue's
-- admin endpoints and mailer are never involved in banning or unbanning.
-- ---------------------------------------------------------------------------

alter table public.organizations add column banned_at timestamptz;

comment on column public.organizations.banned_at is
  'Non-null while the org is banned: the app layer blocks new key mints, invites, and joins on it. Written only by record_org_ban/clear_org_ban.';

create table public.org_bans (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  reason text not null check (length(trim(reason)) between 1 and 500),
  banned_by uuid,
  banned_at timestamptz not null default now()
);

comment on table public.org_bans is
  'Actively banned organizations: who banned, when, why. Enforcement lives in organizations.banned_at; unban deletes the row.';

alter table public.org_bans enable row level security;

-- Platform operators read the roster under their own RLS session (like
-- user_bans); all writes go through the service role.
create policy org_bans_select_admin on public.org_bans
  for select to authenticated
  using (public.is_platform_admin());

grant select on public.org_bans to authenticated;
grant select, insert, update, delete on public.org_bans to service_role;

-- Which org ban swept this user ban, so clear_org_ban restores exactly the
-- members it banned: null for an individual (admin-issued) ban. `set null` on
-- org deletion keeps the user banned — deleting a tenant is not an unban;
-- an operator lifts the leftover ban per user from the admin Users page.
alter table public.user_bans
  add column banned_via_org_id uuid references public.organizations (id) on delete set null;

comment on column public.user_bans.banned_via_org_id is
  'Set when an org ban swept this member; clear_org_ban unbans only these rows. Null = individually banned.';

-- clear_org_ban and the org-deletion `set null` cascade both look bans up by
-- this column; index it so neither seq-scans user_bans (Postgres does not
-- auto-index FK referencing columns).
create index user_bans_banned_via_org_id_idx
  on public.user_bans (banned_via_org_id)
  where banned_via_org_id is not null;

-- ---------------------------------------------------------------------------
-- record_org_ban: the whole org ban in one transaction — the enforcement
-- column, the ban record, org-wide key revocation, pending-invite revocation,
-- and the member sweep through record_user_ban. Atomic on purpose: a
-- partially applied org ban is a banned tenant whose keys still serve gateway
-- traffic or whose members still sign in, and neither may exist even
-- transiently.
-- ---------------------------------------------------------------------------

create or replace function public.record_org_ban(
  in_org_id uuid,
  in_banned_by uuid,
  in_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  member record;
  member_reason text;
begin
  insert into public.org_bans (org_id, reason, banned_by)
  values (in_org_id, in_reason, in_banned_by)
  on conflict (org_id) do update
    set reason = excluded.reason,
        banned_by = excluded.banned_by,
        banned_at = pg_catalog.now();

  update public.organizations
     set banned_at = pg_catalog.now()
   where id = in_org_id;

  -- The whole tenant is banned, so revoke EVERY live key of the org —
  -- deliberately broader than a user ban's created_by scoping.
  update public.api_keys
     set revoked_at = pg_catalog.now()
   where org_id = in_org_id
     and revoked_at is null;

  -- A pending invite token provisions membership at signup (the
  -- provision_signup_org trigger), so outstanding invites must die with the
  -- ban; unban does not restore them.
  update public.org_invitations
     set revoked_at = pg_catalog.now()
   where org_id = in_org_id
     and accepted_at is null
     and revoked_at is null;

  -- Sweep the current members through the existing user-ban path. Platform
  -- operators are never swept (they are the recovery path), and a member
  -- already banned individually keeps that ban's own provenance.
  member_reason := pg_catalog.left('Organization banned: ' || in_reason, 500);
  for member in
    select om.user_id
      from public.organization_members om
     where om.org_id = in_org_id
       and not exists (select 1 from public.user_bans ub where ub.user_id = om.user_id)
       and not exists (select 1 from public.platform_admins pa where pa.user_id = om.user_id)
  loop
    perform public.record_user_ban(member.user_id, in_banned_by, member_reason);
    update public.user_bans
       set banned_via_org_id = in_org_id
     where user_id = member.user_id;
  end loop;
end;
$$;

revoke all on function public.record_org_ban(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_org_ban(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- clear_org_ban: the whole unban in one transaction — clears banned_at,
-- removes the record, and unbans exactly the members this org ban swept. A
-- swept member who still belongs to ANOTHER banned org is not freed: that
-- ban adopts them (banned_via_org_id is reassigned) so unbanning tenant A
-- never quietly restores a member of still-banned tenant B. Individual bans
-- (banned_via_org_id null) are never touched. Idempotent: unbanning an org
-- that is not banned is a no-op. Keys and invites revoked at ban time stay
-- revoked (revocation is one-way everywhere in this schema).
-- ---------------------------------------------------------------------------

create or replace function public.clear_org_ban(in_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  swept record;
  adopting_org_id uuid;
begin
  delete from public.org_bans where org_id = in_org_id;

  -- Clear the enforcement column first so the adoption lookup below sees
  -- this org as no longer banned.
  update public.organizations
     set banned_at = null
   where id = in_org_id
     and banned_at is not null;

  for swept in
    select ub.user_id
      from public.user_bans ub
     where ub.banned_via_org_id = in_org_id
  loop
    select o.id
      into adopting_org_id
      from public.organization_members om
      join public.organizations o on o.id = om.org_id
     where om.user_id = swept.user_id
       and o.banned_at is not null
     limit 1;
    if adopting_org_id is not null then
      update public.user_bans
         set banned_via_org_id = adopting_org_id
       where user_id = swept.user_id;
    else
      perform public.clear_user_ban(swept.user_id);
    end if;
  end loop;
end;
$$;

revoke all on function public.clear_org_ban(uuid) from public, anon, authenticated;
grant execute on function public.clear_org_ban(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- admin_list_org_bans: the admin Organizations pages' ban roster. Joins the
-- banning operator's auth email the way admin_list_users does — a definer RPC
-- because PostgREST cannot see the auth schema. plpgsql, not sql, so a fresh
-- local stack can create it before GoTrue makes auth.users.
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_org_bans()
returns table (
  org_id uuid,
  reason text,
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
    select bans.org_id,
           bans.reason,
           bans.banned_by,
           banners.email::text,
           bans.banned_at
      from public.org_bans bans
      left join auth.users banners on banners.id = bans.banned_by;
end;
$$;

revoke all on function public.admin_list_org_bans() from public, anon;
grant execute on function public.admin_list_org_bans() to authenticated, service_role;
