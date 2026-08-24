-- Collapse member and viewer into user: the org role ladder is two rungs.
--
-- Access model, top to bottom: experiential admins (platform_admins) operate
-- the deployment across every tenant from the /admin panel; org admins
-- control one organization (members, API keys, name, spend visibility); users
-- work inside it. member vs viewer never split meaningfully in product
-- surfaces, and a third rung cost more to explain than it protected. Same
-- shape as 20260713180000_collapse_owner_into_admin.sql.
--
-- Deliberately untouched: connector_providers policies still name the retired
-- 'member' role. That surface is agent-era and dormant after the endpoint
-- pivot (20260723 removal kept its schema); its policies grant nothing to the
-- new 'user' role, which is the safe direction. They go when the table goes.

-- Order matters, and only a database with real data proves it: the remap must
-- run with the old CHECK already dropped. The original form updated first and
-- widened second, so on any database carrying actual 'member'/'viewer' rows
-- the update violated the old constraint (which allowed exactly
-- admin/member/viewer) and the whole migration aborted. Fresh databases never
-- hit it - their seeds create only admins, so the update matched zero rows -
-- which is why it passed CI, pgTAP, staging, and every preview branch while
-- blocking the production release outright. Drops are `if exists` so a
-- database left mid-migration by that failure can still roll forward.
alter table public.organization_members
  drop constraint if exists organization_members_role_check;
alter table public.org_invitations
  drop constraint if exists org_invitations_role_check;

update public.organization_members set role = 'user' where role in ('member', 'viewer');
update public.org_invitations set role = 'user' where role in ('member', 'viewer');

alter table public.organization_members
  add constraint organization_members_role_check
    check (role in ('admin', 'user'));

alter table public.organization_members
  alter column role set default 'user';

alter table public.org_invitations
  add constraint org_invitations_role_check
    check (role in ('admin', 'user'));

alter table public.org_invitations
  alter column role set default 'user';
