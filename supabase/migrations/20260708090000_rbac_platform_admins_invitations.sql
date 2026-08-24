-- Experiential Labs world-model platform schema, part 6: role enforcement,
-- platform admins, and tenant-provisioning invitations.
--
-- Roles were stored on organization_members from day one but never consulted.
-- This migration adds the helpers that make them enforceable and a
-- platform_admins table for operator-level access (the tenants admin panel).
-- It also extends the org_invitations table introduced by
-- 20260708060000_invites_and_signup_gate.sql (org-join invites) with the
-- second invite shape: a tenant-provisioning invite (org_id is null) whose
-- acceptance creates the invitee's org plus its first project — the product's
-- mechanism for onboarding a new customer. Invite links carry a token so the
-- invitee may sign up under a different address than the invite was sent to.

-- Shared resolver for the authenticated user id. Mirrors the claim handling in
-- is_org_member: PostgREST exposes the JWT subject either as the flattened
-- `request.jwt.claim.sub` GUC or inside the JSON `request.jwt.claims` blob.
create or replace function public.authenticated_user_id()
returns uuid
language sql
set search_path = ''
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

revoke all on function public.authenticated_user_id() from public, anon;
grant execute on function public.authenticated_user_id() to authenticated, service_role;

-- Platform operators. Membership here is granted by seed (the deployment
-- admin) or by an existing platform admin; it is deliberately not reachable
-- from any signup path.
create table public.platform_admins (
  user_id uuid primary key,
  granted_by uuid,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.platform_admins admins
    where admins.user_id = public.authenticated_user_id()
  );
$$;

revoke all on function public.is_platform_admin() from public, anon, authenticated;
grant execute on function public.is_platform_admin() to authenticated, service_role;

-- Users may see their own admin row (the web shell uses this to decide whether
-- to render the admin panel); only platform admins may see the full roster.
create policy platform_admins_select_self_or_admin
  on public.platform_admins
  for select
  to authenticated
  using (user_id = public.authenticated_user_id() or public.is_platform_admin());

create policy platform_admins_admin_write
  on public.platform_admins
  for insert
  to authenticated
  with check (public.is_platform_admin());

-- Extend org_invitations with the tenant-provisioning shape. Two shapes now
-- share the table:
--   * org_id is set   -> join invite into an existing org with `role`
--     (the original 20260708060000 shape, managed by org admins).
--   * org_id is null  -> tenant-provisioning invite: signup creates a fresh
--     org named after project_name plus that org's first project, with the
--     invitee as owner. Managed by platform admins; the only product path
--     that creates projects.
alter table public.org_invitations
  alter column org_id drop not null;

-- gen_random_uuid is core Postgres (pgcrypto's schema varies by deployment),
-- and its 122 random bits are ample for a single-use invite token.
alter table public.org_invitations
  add column token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  add column project_name text,
  add column revoked_at timestamptz;

-- A tenant-provisioning invite must name the project it will create.
alter table public.org_invitations
  add constraint org_invitations_project_name_required
    check (org_id is not null or nullif(project_name, '') is not null);

-- One live tenant-provisioning invite per email (join invites are constrained
-- per (org, email) by org_invitations_pending_org_email from 20260708060000).
create unique index org_invitations_pending_tenant_email
  on public.org_invitations (lower(email))
  where org_id is null and accepted_at is null and revoked_at is null;

-- The tenants admin panel manages provisioning invitations directly under RLS
-- with the platform admin's JWT (org-join invites keep their service-role
-- write path from 20260708060000).
create policy org_invitations_platform_admin_all
  on public.org_invitations
  for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- Signup-page prefill: resolves an invite link's token to the fields the form
-- may show. Definer because anon cannot read org_invitations; exposes only
-- live invites and only non-sensitive columns.
create or replace function public.lookup_org_invitation(invite_token text)
returns table (email text, project_name text, expires_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select invitations.email, invitations.project_name, invitations.expires_at
  from public.org_invitations invitations
  where invitations.token = invite_token
    and invitations.accepted_at is null
    and invitations.revoked_at is null
    and invitations.expires_at > now();
$$;

revoke all on function public.lookup_org_invitation(text) from public;
grant execute on function public.lookup_org_invitation(text) to anon, authenticated, service_role;

-- Signup tenant provisioning, unifying both invite shapes with the
-- 20260708060000 precedence chain: invite-link token match first, then every
-- pending email-matched invite (a user invited to several orgs lands in all
-- of them), then the signups_enabled-gated personal-org fallback. Verified
-- domain joins (org_domains) still slot in between once that table lands.
-- Seed sessions remain exempt. Invite claims lock their row (FOR UPDATE) so
-- concurrent signups on a shared link serialize instead of double-consuming.
create or replace function public.provision_signup_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  invites_applied boolean := false;
  open_signups boolean;
  new_org_id uuid;
  email_local text;
  org_label text;
  org_slug text;
  project_slug text;
begin
  -- Seeded users (local stack, previews, CI) receive explicit memberships
  -- from seed.sql; skip provisioning for them.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

  -- Token match wins: the invitee followed their invite link, possibly signing
  -- up under a different address than the invite was sent to. Email-matched
  -- invites are still consumed below so a multi-invited user lands everywhere.
  for invite in
    select invitations.id, invitations.org_id, invitations.role, invitations.project_name
    from public.org_invitations invitations
    where invitations.accepted_at is null
      and invitations.revoked_at is null
      and invitations.expires_at > now()
      and (
        invitations.token = nullif(new.raw_user_meta_data ->> 'invite_token', '')
        or lower(invitations.email) = lower(coalesce(new.email, ''))
      )
    for update
  loop
    if invite.org_id is not null then
      -- Join invite: membership in the inviting org at the invited role.
      insert into public.organization_members (org_id, user_id, role)
      values (invite.org_id, new.id, invite.role)
      on conflict (org_id, user_id) do nothing;
    else
      -- Tenant-provisioning invite: fresh org plus its first project, owned
      -- by the invitee.
      org_label := invite.project_name;
      org_slug := trim(both '-' from regexp_replace(lower(org_label), '[^a-z0-9]+', '-', 'g'));
      if org_slug = '' then
        org_slug := 'org';
      end if;
      project_slug := org_slug;
      org_slug := org_slug || '-' || left(new.id::text, 8);

      insert into public.organizations (slug, name)
      values (org_slug, org_label)
      returning id into new_org_id;

      insert into public.organization_members (org_id, user_id, role)
      values (new_org_id, new.id, 'owner');

      insert into public.projects (org_id, slug, name)
      values (new_org_id, project_slug, org_label);
    end if;

    update public.org_invitations
    set accepted_at = now(), accepted_by = new.id
    where id = invite.id;

    invites_applied := true;
  end loop;

  if invites_applied then
    return new;
  end if;

  -- Verified-domain joins (org_domains) slot in here once that table exists.

  -- Personal-org fallback, gated by the signups_enabled kill switch. When
  -- disabled, the user row still lands but no tenancy is provisioned; the
  -- web app treats a memberless session as a rejected signup.
  select settings.signups_enabled into open_signups
  from public.app_settings settings;
  if not coalesce(open_signups, false) then
    return new;
  end if;

  email_local := lower(
    coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'user')
  );
  -- The uuid prefix keeps slugs unique per user; collisions would need two
  -- users sharing an email local part and the same first 8 uuid hex chars.
  org_slug := regexp_replace(email_local, '[^a-z0-9]+', '-', 'g')
    || '-' || left(new.id::text, 8);

  insert into public.organizations (slug, name)
  values (org_slug, email_local)
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, new.id, 'owner');

  return new;
end;
$$;
