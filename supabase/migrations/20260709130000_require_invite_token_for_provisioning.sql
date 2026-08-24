-- Require the secret invite token to consume an invitation at signup.
--
-- Prior versions of provision_signup_org() matched pending invites either by
-- the invite-link `token` (carried in raw_user_meta_data) OR by the signup
-- email. With email confirmation disabled (enable_confirmations = false),
-- GoTrue issues a session for an unverified email, so the email-match branch
-- let anyone who merely knew an invited address self-sign-up that address and
-- be granted the invitee's membership (up to admin) in an org they were never
-- invited to — a cross-tenant takeover of the invited identity.
--
-- The invite link's token is the only proof of inbox ownership (the invitee
-- received it in the email that was sent to them). This redefinition drops the
-- email-match branch entirely: a join or tenant-provisioning invite is consumed
-- only when the signup carries the matching secret token. An email-only signup
-- no longer consumes any invite; it falls through to the signups_enabled-gated
-- personal-org fallback. The personal-org fallback (starter project + example
-- world models) is unchanged from 20260709030000.
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
  new_project_id uuid;
  email_local text;
  org_label text;
  org_slug text;
  project_slug text;
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
      select invitations.id, invitations.org_id, invitations.role, invitations.project_name
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
        -- Tenant-provisioning invite: fresh org plus its first project, owned
        -- by the invitee. No starter examples: the project exists for the
        -- customer's own agent traces.
        org_label := invite.project_name;
        org_slug := trim(both '-' from regexp_replace(lower(org_label), '[^a-z0-9]+', '-', 'g'));
        if org_slug = '' then
          org_slug := 'org';
        end if;
        project_slug := org_slug;
        org_slug := org_slug || '-' || left(new.id::text, 8);

        insert into public.organizations (slug, name)
        values (org_slug, org_label)
        returning id into new_org_id;

        insert into public.organization_members (org_id, user_id, role)
        values (new_org_id, new.id, 'owner');

        insert into public.projects (org_id, slug, name)
        values (new_org_id, project_slug, org_label);
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
  values (new_org_id, new.id, 'owner');

  -- Starter project so the app has somewhere to land after first sign-in,
  -- seeded with the demo workspace's example world models to explore.
  insert into public.projects (org_id, slug, name, description)
  values (new_org_id, 'default', 'Default Project', 'Starter project created with your account.')
  returning id into new_project_id;

  perform public.provision_starter_examples(new_org_id, new_project_id);

  return new;
end;
$$;
