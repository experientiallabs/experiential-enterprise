-- Collapse the owner org role into admin.
--
-- The platform's access model is two tiers: site admins (platform_admins)
-- operate the deployment -- the admin panel, tenant creation, and member
-- provisioning -- and org admins fully control one organization. owner and
-- admin were already one equivalence class everywhere (is_org_admin, API-key
-- management, the tenancy role ladder), so the extra rung only added a role
-- nobody could reason about. Keep admin as the top per-org role; there is no
-- protected seat inside an org -- site admins are the recovery path.

update public.organization_members set role = 'admin' where role = 'owner';
update public.org_invitations set role = 'admin' where role = 'owner';

alter table public.organization_members
  drop constraint organization_members_role_check,
  add constraint organization_members_role_check
    check (role in ('admin', 'member', 'viewer'));

-- Hosted preview branches applied 20260711150000's owner-widened invite
-- constraint before this migration existed; re-tightening here converges
-- them with fresh databases.
alter table public.org_invitations
  drop constraint org_invitations_role_check,
  add constraint org_invitations_role_check
    check (role in ('admin', 'member', 'viewer'));

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
      and members.role = 'admin'
  );
$$;

-- Same provisioning flow as 20260710120000; the invitee and the personal-org
-- signup now land as admin.
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
  org_label text;
  org_slug text;
  invite_token text;
begin
  -- Seeded users (local stack, previews, CI) receive explicit memberships
  -- from seed.sql; skip provisioning for them.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

  -- Token match only: the invitee proves inbox ownership by following their
  -- tokened invite link, so the token rides along as signup metadata. An
  -- unverified signup email is NOT proof of ownership (email confirmation is
  -- disabled), so it must never consume an invite. With no token, no invite
  -- matches and provisioning falls through to the personal-org fallback.
  invite_token := nullif(new.raw_user_meta_data ->> 'invite_token', '');
  if invite_token is not null then
    for invite in
      select invitations.id, invitations.org_id, invitations.role, invitations.org_name
      from public.org_invitations invitations
      where invitations.accepted_at is null
        and invitations.revoked_at is null
        and invitations.expires_at > now()
        and invitations.token = invite_token
      for update
    loop
      if invite.org_id is not null then
        -- Join invite: membership in the inviting org at the invited role.
        insert into public.organization_members (org_id, user_id, role)
        values (invite.org_id, new.id, invite.role)
        on conflict (org_id, user_id) do nothing;
      else
        -- Tenant-provisioning invite: a fresh org owned by the invitee. No
        -- starter examples: the workspace exists for the customer's own
        -- agent traces.
        org_label := invite.org_name;
        org_slug := trim(both '-' from regexp_replace(lower(org_label), '[^a-z0-9]+', '-', 'g'));
        if org_slug = '' then
          org_slug := 'org';
        end if;
        org_slug := org_slug || '-' || left(new.id::text, 8);

        insert into public.organizations (slug, name)
        values (org_slug, org_label)
        returning id into new_org_id;

        insert into public.organization_members (org_id, user_id, role)
        values (new_org_id, new.id, 'admin');
      end if;

      update public.org_invitations
      set accepted_at = now(), accepted_by = new.id
      where id = invite.id;

      invites_applied := true;
    end loop;
  end if;

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
  values (new_org_id, new.id, 'admin');

  -- The org IS the workspace: seed it with the demo examples directly so the
  -- app has something to explore after first sign-in.
  perform public.provision_starter_examples(new_org_id);

  return new;
end;
$$;
