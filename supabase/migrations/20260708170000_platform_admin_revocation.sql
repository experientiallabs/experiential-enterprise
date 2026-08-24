-- Platform-admin grants must be revocable through the same RLS surface that
-- creates them: platform_admins shipped with SELECT and INSERT policies only,
-- so no application-level path could ever remove an operator. Platform admins
-- may now delete rows (their own included — the seed re-grants the deployment
-- admin, and the service role can always repair an empty roster).
create policy platform_admins_admin_delete
  on public.platform_admins
  for delete
  to authenticated
  using (public.is_platform_admin());
