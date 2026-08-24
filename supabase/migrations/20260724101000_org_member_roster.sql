-- Org-scoped member roster with emails.
--
-- organization_members is already member-readable under RLS, but emails live
-- in auth.users, which browser sessions cannot join. This definer RPC is the
-- org-scoped sibling of admin_list_org_members: any member of the target org
-- (or an experiential admin) reads their own org's roster, and only that org.
-- Consumer: the Settings > Members section.

create function public.org_members_with_emails(target_org_id uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not (
    target_org_id in (select public.member_org_ids())
    or public.is_platform_admin()
  ) then
    raise exception 'organization membership required';
  end if;
  return query
    select members.user_id, users.email::text, members.role, members.created_at
    from public.organization_members members
    left join auth.users users on users.id = members.user_id
    where members.org_id = target_org_id
    order by members.created_at;
end;
$$;

revoke all on function public.org_members_with_emails(uuid) from public, anon;
grant execute on function public.org_members_with_emails(uuid) to authenticated, service_role;
