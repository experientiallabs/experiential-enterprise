-- Platform-admin organization writes run under the signed-in admin's RLS
-- session (app/api/admin/orgs), but authenticated only ever held SELECT on
-- the table: the organizations_platform_admin_insert/update policies were
-- unreachable, and creation failed with "permission denied for table
-- organizations" (the product owner, 2026-08-01). RLS still gates every row - these
-- grants only make the existing is_platform_admin() policies reachable.
grant insert, update on table public.organizations to authenticated;
