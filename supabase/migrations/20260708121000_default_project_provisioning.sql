-- Personal orgs get a starter project with example world models at signup.
--
-- The home page routes to the user's first project and 404s when there is
-- none; invited users land in an org that already has projects, but a
-- self-serve signup's fresh personal org was empty. Provision a default
-- project alongside the personal org, seed it with copies of the demo
-- workspace's example world models so the first session has something to
-- explore, and backfill both for existing orgs with no projects (early
-- OAuth signups from before this migration).

-- Copies the demo project's example world models (and their trace-upload
-- rows) into a target project. The copies reference the demo fixtures'
-- storage objects rather than duplicating bytes: nothing in the app deletes
-- storage objects and trace bytes are only read through the service role,
-- so cross-org sharing is safe. On stacks without the demo seed (or during
-- migrations on a fresh database, which run before seed.sql) the source
-- select is empty and this is a no-op.
create or replace function public.provision_starter_examples(
  target_org_id uuid,
  target_project_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  example record;
  copied_wm_id uuid;
begin
  for example in
    select wm.id, wm.name, wm.display_name, wm.serve_provider, wm.serve_model,
           wm.embed_provider, wm.embed_dim, wm.gepa_budget, wm.trace_adapter,
           wm.config
    from public.world_models wm
    where wm.project_id = '00000000-0000-0000-0000-000000000002'
    order by wm.name
  loop
    -- Copies always start life unbuilt: the demo row's build state, artifact
    -- link, metrics, and error stay behind.
    insert into public.world_models (
      org_id, project_id, name, display_name, status, serve_provider,
      serve_model, embed_provider, embed_dim, gepa_budget, trace_adapter,
      config
    )
    values (
      target_org_id, target_project_id, example.name, example.display_name,
      'created', example.serve_provider, example.serve_model,
      example.embed_provider, example.embed_dim, example.gepa_budget,
      example.trace_adapter, example.config
    )
    returning id into copied_wm_id;

    insert into public.trace_uploads (
      org_id, project_id, world_model_id, filename, storage_path, byte_size,
      sha256, adapter, trace_count, step_count, status
    )
    select target_org_id, target_project_id, copied_wm_id, uploads.filename,
           uploads.storage_path, uploads.byte_size, uploads.sha256,
           uploads.adapter, uploads.trace_count, uploads.step_count,
           'uploaded'
    from public.trace_uploads uploads
    where uploads.world_model_id = example.id
      and uploads.status = 'uploaded';
  end loop;
end;
$$;

-- Writes into arbitrary orgs: never callable through PostgREST. Only the
-- signup trigger (definer, so it runs as postgres) and migrations invoke it.
revoke all on function public.provision_starter_examples(uuid, uuid)
  from public, anon, authenticated;

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
  org_slug text;
begin
  -- Seeded users (local stack, previews, CI) receive explicit memberships
  -- from seed.sql; skip provisioning for them.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

  -- Invite branch: consume every pending, unexpired invite for this email so
  -- a user invited to several orgs lands in all of them.
  for invite in
    select invitations.id, invitations.org_id, invitations.role
    from public.org_invitations invitations
    where lower(invitations.email) = lower(coalesce(new.email, ''))
      and invitations.accepted_at is null
      and invitations.expires_at > now()
  loop
    insert into public.organization_members (org_id, user_id, role)
    values (invite.org_id, new.id, invite.role)
    on conflict (org_id, user_id) do nothing;

    update public.org_invitations
    set accepted_at = now(), accepted_by = new.id
    where id = invite.id;

    invites_applied := true;
  end loop;

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

-- Backfill: personal orgs created between the OAuth launch and this
-- migration have no projects and 404 on the home page. Scoped to the
-- personal-org signature (exactly one member, an owner) so a hypothetical
-- project-less team org is not handed a "created with your account" project.
-- On a live database the seed rows already exist, so the backfilled projects
-- also receive the example world models.
do $$
declare
  org record;
  new_project_id uuid;
begin
  for org in
    select orgs.id
    from public.organizations orgs
    where not exists (
      select 1 from public.projects projects where projects.org_id = orgs.id
    )
    and (
      select count(*) from public.organization_members members
      where members.org_id = orgs.id
    ) = 1
    and exists (
      select 1 from public.organization_members members
      where members.org_id = orgs.id and members.role = 'owner'
    )
  loop
    insert into public.projects (org_id, slug, name, description)
    values (org.id, 'default', 'Default Project', 'Starter project created with your account.')
    returning id into new_project_id;

    perform public.provision_starter_examples(org.id, new_project_id);
  end loop;
end
$$;
