-- Adding an existing account to an organization needs the account id for an
-- email, and auth.users is unreadable from RLS sessions. Definer lookup,
-- gated hard on platform admins (service-role calls allowed) so it cannot be
-- used to probe which emails have accounts.
create function public.admin_user_id_for_email(target_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  found uuid;
begin
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(current_setting('request.jwt.claim.role', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
       ) = 'service_role'
  ) then
    raise exception 'platform admin required';
  end if;
  select users.id into found from auth.users users where lower(users.email) = lower(target_email);
  return found;
end;
$$;

revoke all on function public.admin_user_id_for_email(text) from public, anon;
grant execute on function public.admin_user_id_for_email(text) to authenticated, service_role;
