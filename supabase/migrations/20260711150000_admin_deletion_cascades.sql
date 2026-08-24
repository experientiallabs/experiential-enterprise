-- Site-admin deletion invariants.
--
-- GoTrue owns auth.users, so public user references deliberately are not FKs
-- on the local Docker migration pass (GoTrue creates its tables afterwards).
-- Attach one auth.users delete trigger instead: every GoTrue/admin deletion
-- cleans user-owned public rows inside the same database transaction.

create or replace function public.cleanup_deleted_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.organization_members where user_id = old.id;
  delete from public.platform_admins where user_id = old.id;
  update public.platform_admins set granted_by = null where granted_by = old.id;

  -- Remove the deleted account's own invite history so the address can be
  -- invited again. Invites created for other people remain useful but lose
  -- the deleted operator provenance.
  delete from public.org_invitations
   where accepted_by = old.id
      or (old.email is not null and lower(email) = lower(old.email));
  update public.org_invitations set invited_by = null where invited_by = old.id;

  delete from public.wm_catalog_entry_likes where user_id = old.id;
  delete from public.user_onboarding where user_id = old.id;
  delete from public.agent_session_commands where actor_id = old.id;

  -- These resources belong to organizations, not their original creator.
  -- Preserve them while removing the stale auth-user pointer.
  update public.api_keys set created_by = null where created_by = old.id;
  update public.harnesses set created_by = null where created_by = old.id;
  update public.harness_versions set created_by = null where created_by = old.id;
  update public.agent_sessions set created_by = null where created_by = old.id;

  return old;
end;
$$;

revoke all on function public.cleanup_deleted_auth_user() from public, anon, authenticated;

-- Local Docker applies product migrations before GoTrue creates auth.users.
-- This idempotent helper attaches the trigger immediately on hosted Supabase
-- and is called again by seed.sql after local GoTrue becomes healthy.
create or replace function public.ensure_auth_user_cleanup_trigger()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regclass('auth.users') is null then
    return;
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_trigger triggers
     where triggers.tgname = 'cleanup_deleted_auth_user'
       and triggers.tgrelid = 'auth.users'::regclass
       and not triggers.tgisinternal
  ) then
    execute 'create trigger cleanup_deleted_auth_user
      after delete on auth.users
      for each row execute function public.cleanup_deleted_auth_user()';
  end if;
end;
$$;

revoke all on function public.ensure_auth_user_cleanup_trigger() from public, anon, authenticated;

select public.ensure_auth_user_cleanup_trigger();

-- One transaction deletes the complete tenant graph through existing
-- organization FKs, then removes former members from auth only when they have
-- no other organization. Platform operators and the current operator are
-- intentionally preserved even if their last ordinary membership disappears.
create or replace function public.admin_delete_organization(target_org_id uuid)
returns table (deleted_org_id uuid, deleted_user_count bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := public.authenticated_user_id();
  candidate_user_ids uuid[];
  removed_org_id uuid;
  removed_user_count bigint := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin required' using errcode = '42501';
  end if;

  select coalesce(array_agg(members.user_id), '{}'::uuid[])
    into candidate_user_ids
    from public.organization_members members
   where members.org_id = target_org_id;

  delete from public.organizations organizations
   where organizations.id = target_org_id
  returning organizations.id into removed_org_id;

  if removed_org_id is null then
    return;
  end if;

  delete from auth.users users
   where users.id = any(candidate_user_ids)
     and users.id <> actor_id
     and not exists (
       select 1
         from public.organization_members memberships
        where memberships.user_id = users.id
     )
     and not exists (
       select 1
         from public.platform_admins admins
        where admins.user_id = users.id
     );
  get diagnostics removed_user_count = row_count;

  return query select removed_org_id, removed_user_count;
end;
$$;

revoke all on function public.admin_delete_organization(uuid) from public, anon, service_role;
grant execute on function public.admin_delete_organization(uuid) to authenticated;
