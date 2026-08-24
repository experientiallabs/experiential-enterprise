-- Invite-based signups and the account-creation gate.
--
-- Adds the org_invitations table anticipated by provision_signup_org()'s
-- precedence chain (invite -> domain -> personal org), plus a single-row
-- app_settings table whose signups_enabled flag gates the personal-org
-- fallback. The flag ships enabled for the initial rollout (so the first
-- accounts can self-serve); flipping it to false makes account creation
-- invite-only: an uninvited new auth user is still created by GoTrue (that
-- insert is not ours to veto) but receives no membership, and the web app
-- rejects memberless sessions with an error.

create table public.app_settings (
  singleton boolean primary key default true check (singleton),
  signups_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (singleton) values (true);

create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

create table public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (position('@' in email) > 1),
  role text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  -- Set when the invite provisions an account: for panel-sent invites GoTrue
  -- creates the auth user at send time, so this marks "account created and
  -- membership granted", not "the invitee clicked the email link".
  accepted_at timestamptz,
  accepted_by uuid
);

-- One pending invite per (org, email); accepted invites remain as history.
create unique index org_invitations_pending_org_email
  on public.org_invitations (org_id, lower(email))
  where accepted_at is null;

create index org_invitations_pending_email_idx
  on public.org_invitations (lower(email))
  where accepted_at is null;

grant select, insert, update, delete on public.app_settings to service_role;
grant select, insert, update, delete on public.org_invitations to service_role;
grant select on public.org_invitations to authenticated;

-- Admin-role variant of is_org_member for invite-management surfaces.
create or replace function public.is_org_admin(target_org_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  with authenticated_user as (
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid as user_id
  )
  select exists (
    select 1
    from public.organization_members members
    join authenticated_user on authenticated_user.user_id = members.user_id
    where members.org_id = target_org_id
      and members.role in ('owner', 'admin')
  );
$$;

-- Same execute hygiene as is_org_member: strip Supabase's default PUBLIC/anon
-- grants from this definer-rights helper.
revoke all on function public.is_org_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_org_admin(uuid) to authenticated, service_role;

alter table public.app_settings enable row level security;
alter table public.org_invitations enable row level security;

-- app_settings has no authenticated policies: it is read by the signup
-- trigger (definer rights) and the service role only.

create policy org_invitations_select_admin
  on public.org_invitations
  for select
  to authenticated
  using (public.is_org_admin(org_id));

-- Invite writes go through the admin API routes on the service role (which
-- bypasses RLS) so invite emails and row changes stay in one code path.

-- Implement the invite branch of the provisioning precedence chain and gate
-- the personal-org fallback behind app_settings.signups_enabled.
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
  org_slug text;
begin
  -- Seeded users (local stack, previews, CI) receive explicit memberships
  -- from seed.sql; skip provisioning for them.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

  -- Invite branch: consume every pending, unexpired invite for this email so
  -- a user invited to several orgs lands in all of them.
  for invite in
    select invitations.id, invitations.org_id, invitations.role
    from public.org_invitations invitations
    where lower(invitations.email) = lower(coalesce(new.email, ''))
      and invitations.accepted_at is null
      and invitations.expires_at > now()
  loop
    insert into public.organization_members (org_id, user_id, role)
    values (invite.org_id, new.id, invite.role)
    on conflict (org_id, user_id) do nothing;

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
