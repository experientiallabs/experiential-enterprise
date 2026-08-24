-- Platform-admin organization and membership administration.
--
-- The tenants panel gains full org lifecycle control: create and delete
-- organizations, remove members, and move a member between organizations.
-- Writes go through the signed-in admin's RLS session like the tenant-invite
-- panel (user deletion is the one exception — auth.users is GoTrue's and
-- requires the service-role admin API, enforced in the route).

-- Organizations: platform admins administer every tenant, so they also see
-- every tenant (the member-scoped select policy alone would hide orgs they do
-- not belong to). Deleting an organization cascades through projects, world
-- models, and sessions by FK.
create policy organizations_platform_admin_select
  on public.organizations
  for select
  to authenticated
  using (public.is_platform_admin());

create policy organizations_platform_admin_insert
  on public.organizations
  for insert
  to authenticated
  with check (public.is_platform_admin());

create policy organizations_platform_admin_update
  on public.organizations
  for update
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

create policy organizations_platform_admin_delete
  on public.organizations
  for delete
  to authenticated
  using (public.is_platform_admin());

-- Memberships: platform admins grant, change, and revoke org membership —
-- reassignment is a delete plus insert under one authenticated session.
create policy organization_members_platform_admin_all
  on public.organization_members
  for all
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- Member roster with emails for the admin panel. Emails live in auth.users,
-- which RLS clients cannot read, so a definer RPC joins them — gated hard on
-- platform admin rather than grants alone.
create function public.admin_list_org_members()
returns table (org_id uuid, user_id uuid, email text, role text, created_at timestamptz)
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
    select members.org_id, members.user_id, users.email::text, members.role, members.created_at
    from public.organization_members members
    left join auth.users users on users.id = members.user_id
    order by members.created_at;
end;
$$;

revoke all on function public.admin_list_org_members() from public, anon;
grant execute on function public.admin_list_org_members() to authenticated, service_role;

-- Invite pre-flight: an invite email that already belongs to an org member is
-- a mistake, and one that already has an account can never be consumed (the
-- provisioning trigger only fires on auth.users insert), so the invite routes
-- refuse both up front. Gated on the caller administering the target org (or
-- being a platform admin) so the definer read cannot probe arbitrary emails.
create function public.invitee_account_state(target_org_id uuid, target_email text)
returns text
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  normalized text := lower(target_email);
  invitee_id uuid;
begin
  -- The org-invite route calls this through the service-role client (its
  -- own org-admin check already ran app-side); browser sessions must hold
  -- an admin role themselves.
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(current_setting('request.jwt.claim.role', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
       ) = 'service_role'
    or (target_org_id is not null and public.is_org_admin(target_org_id))
  ) then
    raise exception 'organization admin required';
  end if;

  select users.id into invitee_id from auth.users users where lower(users.email) = normalized;
  if invitee_id is null then
    return 'none';
  end if;
  if target_org_id is not null and exists (
    select 1 from public.organization_members members
    where members.org_id = target_org_id and members.user_id = invitee_id
  ) then
    return 'member';
  end if;
  return 'user';
end;
$$;

revoke all on function public.invitee_account_state(uuid, text) from public, anon;
grant execute on function public.invitee_account_state(uuid, text) to authenticated, service_role;
