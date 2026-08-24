-- Account workspaces receive one application-provisioned ready world model
-- and Default agent independently of the optional optimizer walkthrough.
--
-- The auth trigger cannot build the agent's real pi-node HarnessDoc: that
-- document includes wmh's vendored runtime surfaces and is owned by the
-- Python engine boundary. This table is the durable handoff. The API startup
-- seed and the signed-in root gate both consume it idempotently, so the
-- seeded operator and a brand-new self-serve account converge on the same
-- ready v0 agent even when onboarding is skipped or interrupted.

create table public.account_workspaces (
  user_id uuid primary key,
  org_id uuid not null unique references public.organizations(id) on delete cascade,
  starter_world_model_id uuid references public.world_models(id) on delete set null,
  default_agent_id uuid references public.agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, user_id)
    references public.organization_members(org_id, user_id) on delete cascade
);

create index account_workspaces_starter_world_model_idx
  on public.account_workspaces (starter_world_model_id)
  where starter_world_model_id is not null;

create index account_workspaces_default_agent_idx
  on public.account_workspaces (default_agent_id)
  where default_agent_id is not null;

create trigger account_workspaces_set_updated_at
before update on public.account_workspaces
for each row execute function public.set_updated_at();

alter table public.account_workspaces enable row level security;

-- The service-role backend is the only reader/writer. Browser clients learn
-- about the resulting ordinary world_models/agents rows through their
-- existing org-scoped APIs and never need this provisioning metadata.
revoke all on table public.account_workspaces from public, anon, authenticated;
grant select, insert, update, delete on table public.account_workspaces to service_role;

-- Serialize bootstrap on the account row and commit the catalog import,
-- cloned lineage, and repair pointer together. A ready world-model row must
-- never become visible before its follow-up writes can no longer roll it
-- back: concurrent root requests are expected during first navigation.
create function public.ensure_account_starter_world_model(
  in_user_id uuid,
  in_catalog_name text,
  in_model_name text
)
returns setof public.world_models
language plpgsql
security definer
set search_path = ''
as $$
declare
  workspace public.account_workspaces%rowtype;
  entry public.wm_catalog_entries%rowtype;
  starter public.world_models%rowtype;
  upload_id uuid;
begin
  select workspaces.* into workspace
  from public.account_workspaces workspaces
  where workspaces.user_id = in_user_id
  for update;

  if not found then
    return;
  end if;

  if workspace.starter_world_model_id is not null then
    select models.* into starter
    from public.world_models models
    where models.id = workspace.starter_world_model_id;

    if not found
      or starter.org_id <> workspace.org_id
      or starter.status <> 'ready'::public.world_model_status
    then
      raise exception 'invalid starter world-model pointer for account %', in_user_id;
    end if;

    return next starter;
    return;
  end if;

  select entries.* into entry
  from public.wm_catalog_entries entries
  where entries.name = in_catalog_name
    and entries.deprecated_at is null;

  if not found then
    raise exception 'required starter catalog entry is missing: %', in_catalog_name;
  end if;

  if exists (
    select 1
    from public.world_models models
    where models.org_id = workspace.org_id
      and models.name = in_model_name
  ) then
    raise exception 'reserved starter world-model name is already in use: %', in_model_name;
  end if;

  if entry.traces_storage_path is not null and (
    entry.traces_filename is null
    or entry.traces_byte_size is null
    or entry.traces_sha256 is null
  ) then
    raise exception 'starter catalog entry % has an incomplete trace corpus pointer', entry.id;
  end if;

  insert into public.world_models (
    org_id,
    name,
    display_name,
    status,
    serve_provider,
    serve_model,
    embed_provider,
    embed_dim,
    gepa_budget,
    trace_adapter,
    config,
    artifact_id,
    catalog_entry_id,
    metrics,
    error
  )
  values (
    workspace.org_id,
    in_model_name,
    entry.display_name,
    'ready',
    entry.serve_provider,
    entry.serve_model,
    entry.embed_provider,
    entry.embed_dim,
    null,
    entry.trace_adapter,
    entry.config,
    null,
    entry.id,
    entry.metrics,
    null
  )
  returning * into starter;

  if entry.traces_storage_path is not null then
    insert into public.trace_uploads (
      org_id,
      world_model_id,
      filename,
      storage_path,
      byte_size,
      sha256,
      adapter,
      trace_count,
      step_count,
      status
    )
    values (
      workspace.org_id,
      starter.id,
      entry.traces_filename,
      entry.traces_storage_path,
      entry.traces_byte_size,
      entry.traces_sha256,
      entry.trace_adapter,
      entry.trace_count,
      entry.step_count,
      'uploaded'
    )
    returning id into upload_id;

    insert into public.build_jobs (
      world_model_id,
      trace_upload_id,
      evaluate,
      status,
      gepa_budget,
      runtime_backend,
      progress,
      started_at,
      finished_at
    )
    values (
      starter.id,
      upload_id,
      false,
      'completed',
      null,
      'catalog-import',
      jsonb_strip_nulls(jsonb_build_object(
        'phase', 'completed',
        'traces', entry.trace_count,
        'steps', entry.step_count
      )),
      now(),
      now()
    );
  end if;

  update public.account_workspaces workspaces
  set starter_world_model_id = starter.id
  where workspaces.user_id = in_user_id;

  return next starter;
end;
$$;

revoke all on function public.ensure_account_starter_world_model(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ensure_account_starter_world_model(uuid, text, text)
  to service_role;

-- Preserve the current invite precedence and starter-example behavior while
-- marking only the personal-org fallback for account bootstrap. Join invites
-- must not create one agent per invitee inside an existing shared org, and
-- tenant-provisioning invites intentionally start from the customer's own
-- traces rather than the platform starter.
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
  -- and an account-workspace marker from seed.sql; skip normal provisioning.
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
        values (new_org_id, new.id, 'owner');
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
  values (new_org_id, new.id, 'owner');

  insert into public.account_workspaces (user_id, org_id)
  values (new.id, new_org_id);

  -- Keep the existing explorable unbuilt examples. Application bootstrap
  -- additionally imports one canonical ready catalog model for the Default
  -- agent, without running a build or making provider calls.
  perform public.provision_starter_examples(new_org_id);

  return new;
end;
$$;

-- Recover pre-migration personal workspaces by reproducing the personal
-- fallback's exact email-derived name and slug. The looser uuid-suffix shape
-- also belongs to tenant-provisioning invites, which must stay excluded.
-- Local migrations can run before GoTrue creates auth.users; those stacks
-- have no pre-migration accounts to recover and the live signup trigger
-- records all later personal workspaces.
do $$
begin
  if to_regclass('auth.users') is not null then
    insert into public.account_workspaces (user_id, org_id)
    select members.user_id, orgs.id
    from public.organizations orgs
    join public.organization_members members
      on members.org_id = orgs.id and members.role = 'owner'
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
    on conflict do nothing;
  end if;
end
$$;
