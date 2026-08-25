-- Resolve operator-supplied emails to their organizations (superadmin lookup).
--
-- Operators hold founder emails, not org ids, but the per-org admin actions
-- (the YC launch grant, labels, the welcome trigger) key on org_id. This
-- definer function maps email -> org(s) by joining auth.users (which RLS hides,
-- so the read must live in a definer body, mirroring auth_user_verification)
-- through organization_members to organizations. Gated to platform admins and
-- the service role exactly like auth_user_verification, so only the admin API
-- (never an end user) can enumerate who owns which org.

create function public.admin_orgs_for_emails(in_emails pg_catalog.text[])
returns table (
  email pg_catalog.text,
  org_id pg_catalog.uuid,
  org_slug pg_catalog.text,
  org_name pg_catalog.text,
  member_role pg_catalog.text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(current_setting('request.jwt.claim.role', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
       ) = 'service_role'
  ) then
    raise exception 'not authorized to resolve emails to orgs';
  end if;
  return query
    select
      lower(users.email)::text,
      orgs.id,
      orgs.slug::text,
      orgs.name::text,
      members.role::text
    from auth.users users
    join public.organization_members members on members.user_id = users.id
    join public.organizations orgs on orgs.id = members.org_id
    where lower(users.email) = any (select lower(e) from unnest(in_emails) as e);
end;
$$;

revoke all on function public.admin_orgs_for_emails(pg_catalog.text[])
  from public, anon, authenticated;
grant execute on function public.admin_orgs_for_emails(pg_catalog.text[]) to service_role;
