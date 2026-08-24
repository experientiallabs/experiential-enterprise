-- Org -> earliest-member email for the nightly digest (gw/analytics).
--
-- The digest excludes synthetic accounts (plus-aliased emails, the
-- tests/synthetic-email.ts convention) from every metric and labels its
-- top-users breakdown by the human behind each org. Emails live in
-- auth.users, which PostgREST never exposes, so this is a definer lookup in
-- the same shape as admin_org_member_roster: service-role only, reads only
-- the earliest member's email per requested org.
--
-- plpgsql, not sql, deliberately: on a fresh Docker stack auth.users does not
-- exist at migrate time (GoTrue boots after supabase-migrate), and a sql
-- function body is validated at creation while a plpgsql body resolves its
-- relations at first call — the same ordering constraint the notify_signup
-- trigger handles with its ensure-function deferral.

create or replace function public.analytics_org_member_emails(in_org_ids uuid[])
returns table (org_id uuid, email text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select distinct on (members.org_id)
    members.org_id,
    users.email::text
  from public.organization_members members
  join auth.users users on users.id = members.user_id
  where members.org_id = any (in_org_ids)
  order by members.org_id, members.created_at asc, members.user_id asc;
end;
$$;

revoke all on function public.analytics_org_member_emails(uuid[])
  from public, anon, authenticated;
grant execute on function public.analytics_org_member_emails(uuid[])
  to service_role;
