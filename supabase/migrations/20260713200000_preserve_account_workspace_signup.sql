-- The owner-to-admin migration replaced provision_signup_org() after account
-- workspaces were introduced, restoring the older body and dropping the
-- personal-signup account_workspaces insert. Reapply the combined final form
-- as a forward migration so already-migrated deployments are repaired too.
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
  -- Seeded users receive their membership and account-workspace marker from
  -- seed.sql, so normal signup provisioning must leave them unchanged.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

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
        insert into public.organization_members (org_id, user_id, role)
        values (invite.org_id, new.id, invite.role)
        on conflict (org_id, user_id) do nothing;
      else
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

  select settings.signups_enabled into open_signups
  from public.app_settings settings;
  if not coalesce(open_signups, false) then
    return new;
  end if;

  email_local := lower(
    coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'user')
  );
  org_slug := regexp_replace(email_local, '[^a-z0-9]+', '-', 'g')
    || '-' || left(new.id::text, 8);

  insert into public.organizations (slug, name)
  values (org_slug, email_local)
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, new.id, 'admin');

  insert into public.account_workspaces (user_id, org_id)
  values (new.id, new_org_id);

  perform public.provision_starter_examples(new_org_id);

  return new;
end;
$$;

-- Repair personal workspaces created after the account-workspace migration
-- was deployed but while the later owner-to-admin function body was active.
-- Match the personal naming shape and exclude users whose accepted null-org
-- invite proves that signup provisioned a customer tenant instead.
do $$
begin
  if to_regclass('auth.users') is not null then
    insert into public.account_workspaces (user_id, org_id)
    select members.user_id, orgs.id
    from public.organizations orgs
    join public.organization_members members
      on members.org_id = orgs.id and members.role = 'admin'
    join auth.users users on users.id = members.user_id
    cross join lateral (
      select lower(
        coalesce(nullif(split_part(coalesce(users.email, ''), '@', 1), ''), 'user')
      ) as email_local
    ) email_identity
    where orgs.name = email_identity.email_local
      and orgs.slug = regexp_replace(email_identity.email_local, '[^a-z0-9]+', '-', 'g')
        || '-' || left(members.user_id::text, 8)
      and (
        select count(*)
        from public.organization_members org_members
        where org_members.org_id = orgs.id
      ) = 1
      and not exists (
        select 1
        from public.org_invitations invitations
        where invitations.accepted_by = members.user_id
          and invitations.accepted_at is not null
          and invitations.org_id is null
      )
    on conflict do nothing;
  end if;
end
$$;
