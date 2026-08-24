-- ORG-ONLY WORKSPACES: remove the project concept.
--
-- The organization is now the workspace: world models, agents, traces,
-- artifacts, harnesses, sessions, rollouts, and secrets hang directly off
-- orgs, and users <-> orgs stays many-to-many with roles. The project level
-- scoped no permissions, budget, or keys of its own (all org-level), so it
-- was navigation depth that routinely read as "I added someone to X but
-- they see nothing".
--
-- Order of operations matters throughout:
--   1. Demo examples move to a dedicated demo org (rows re-pointed while
--      project_id still exists to find them).
--   2. Name uniqueness moves project -> org scope (collision-safe renames
--      first).
--   3. project_secrets becomes org_secrets (dedupe, rename, org-keyed RPCs).
--   4. Tenant invites carry the org name (column rename + lookup RPC).
--   5. Provisioning goes org-only (no starter project).
--   6. Org-scoped replacement indexes; project_id columns drop everywhere.
--   7. The projects table drops last.

-- ---------------------------------------------------------------------------
-- 1. Demo examples org. The starter-example pool used to be "the demo
-- project" inside the operator org; it becomes a dedicated org, reusing the
-- demo project's stable uuid so seeded stacks and production migrate with a
-- straight re-point. Row moves fire the org_id spend-counter triggers, so
-- both orgs' spend_usd stay truthful without a recompute.
--
-- Deliberate visibility tradeoff: the demo org is memberless, so the demo
-- workspace's HISTORY (sessions/rollouts operator-org members ran against
-- the example models) moves out of those members' RLS scope and stays
-- reachable only through the platform-admin bypass. The rows survive; an
-- operator can re-grant access by adding members to the demo-examples org.
do $$
begin
  if exists (
    select 1 from public.projects
    where id = '00000000-0000-0000-0000-000000000002'
  ) then
    insert into public.organizations (id, slug, name, usage_limit_usd)
    values (
      '00000000-0000-0000-0000-000000000002',
      'demo-examples',
      'Demo Examples',
      null
    )
    on conflict (id) do nothing;

    update public.world_models
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.trace_uploads
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.wm_sessions
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.wm_rollouts
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.artifacts
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.agents
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.agent_opt_runs
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.harnesses
       set org_id = '00000000-0000-0000-0000-000000000002'
     where project_id = '00000000-0000-0000-0000-000000000002';
    update public.build_jobs jobs
       set org_id = '00000000-0000-0000-0000-000000000002'
      from public.world_models models
     where models.id = jobs.world_model_id
       and models.org_id = '00000000-0000-0000-0000-000000000002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Name uniqueness moves to org scope. Two projects in one org could hold
-- same-named rows; the OLDEST row keeps its name (name-keyed registry
-- lookups keep addressing the longest-lived record) and every later
-- duplicate gets a short id suffix (names stay wmh-slug-safe) so the
-- org-scoped unique can attach. Every rename is logged with a NOTICE so the
-- deploy log records exactly which rows changed address. (Secrets below use
-- the opposite newest-wins rule deliberately: a credential's most recent
-- value is the live one, while a name-addressed resource's oldest holder is
-- the established one.)
do $$
declare
  renamed record;
begin
  for renamed in
    with ranked as (
      select id, name, row_number() over (
        partition by org_id, name order by created_at, id
      ) as rn
      from public.world_models
    ),
    changed as (
      update public.world_models rows
         set name = rows.name || '-' || left(rows.id::text, 8)
        from ranked
       where ranked.id = rows.id and ranked.rn > 1
      returning rows.id, ranked.name as old_name, rows.name as new_name
    )
    select * from changed
  loop
    raise notice 'org-only collapse: world_model % renamed % -> %',
      renamed.id, renamed.old_name, renamed.new_name;
  end loop;

  for renamed in
    with ranked as (
      select id, name, row_number() over (
        partition by org_id, name order by created_at, id
      ) as rn
      from public.agents
    ),
    changed as (
      update public.agents rows
         set name = rows.name || '-' || left(rows.id::text, 8)
        from ranked
       where ranked.id = rows.id and ranked.rn > 1
      returning rows.id, ranked.name as old_name, rows.name as new_name
    )
    select * from changed
  loop
    raise notice 'org-only collapse: agent % renamed % -> %',
      renamed.id, renamed.old_name, renamed.new_name;
  end loop;

  for renamed in
    with ranked as (
      select id, name, row_number() over (
        partition by org_id, name order by created_at, id
      ) as rn
      from public.harnesses
    ),
    changed as (
      update public.harnesses rows
         set name = rows.name || '-' || left(rows.id::text, 8)
        from ranked
       where ranked.id = rows.id and ranked.rn > 1
      returning rows.id, ranked.name as old_name, rows.name as new_name
    )
    select * from changed
  loop
    raise notice 'org-only collapse: harness % renamed % -> %',
      renamed.id, renamed.old_name, renamed.new_name;
  end loop;
end;
$$;

alter table public.world_models
  add constraint world_models_org_id_name_key unique (org_id, name);
alter table public.agents
  add constraint agents_org_id_name_key unique (org_id, name);
alter table public.harnesses
  add constraint harnesses_org_id_name_key unique (org_id, name);

-- ---------------------------------------------------------------------------
-- 3. Secrets: project_secrets -> org_secrets. Same-named active secrets from
-- different projects in one org dedupe to the most recently updated; losers
-- are revoked, NOT deleted — their rows keep last4/metadata and their Vault
-- entries keep the values, so an operator can inspect what each project used
-- and re-upsert the right value if newest-wins picked wrong. Any collapse of
-- per-project values into one org value must choose; newest-wins is the
-- deterministic choice, and the revoked_reason below marks every row it
-- demoted for audit.
-- Every secret row — winner or demoted — keeps its origin project in
-- metadata before the project_id column drops below, so all lineage stays
-- queryable (the Vault name embeds the same uuid, but metadata is the
-- documented audit surface).
update public.project_secrets secrets
   set metadata = secrets.metadata
     || jsonb_build_object('origin_project_id', secrets.project_id::text);

with ranked as (
  select id, row_number() over (
    partition by org_id, name order by updated_at desc, id
  ) as rn
  from public.project_secrets
  where revoked_at is null
)
update public.project_secrets secrets
   set revoked_at = now(),
       revoked_reason = 'superseded by the org-scoped secret (org-only workspaces migration)'
  from ranked
 where ranked.id = secrets.id and ranked.rn > 1;

alter table public.project_secrets rename to org_secrets;
alter policy project_secrets_service_role_rw on public.org_secrets
  rename to org_secrets_service_role_rw;
alter index public.project_secrets_org_id_idx rename to org_secrets_org_id_idx;
drop index public.project_secrets_active_project_name;
-- Drops the project FK (and its covering index) with the column, so the
-- projects table has no remaining dependents when it drops below.
alter table public.org_secrets drop column project_id;
create unique index org_secrets_active_org_name
  on public.org_secrets (org_id, name)
  where revoked_at is null;

drop function public.upsert_project_secret(uuid, text, text, text, jsonb);
drop function public.get_project_secret(uuid, text);
drop function public.list_project_secrets(uuid);
drop function public.list_project_secret_metadata(uuid);

create function public.upsert_org_secret(
  in_org_id uuid,
  in_name text,
  in_secret text,
  in_updated_by text default null,
  in_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  org_id uuid,
  name text,
  last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz,
  updated_at timestamptz,
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_secret_id uuid;
  normalized_name text := lower(nullif(btrim(in_name), ''));
  actor text := nullif(btrim(in_updated_by), '');
  vault_secret uuid;
  existing_vault_secret uuid;
  vault_name text;
  value_last4 text;
begin
  if in_org_id is null then
    raise exception 'org_id is required';
  end if;
  if normalized_name is null then
    raise exception 'secret name is required';
  end if;
  if normalized_name not in (
    'anthropic_api_key',
    'openai_api_key',
    'aws_access_key_id',
    'aws_secret_access_key',
    'aws_region',
    'azure_openai_api_key',
    'azure_openai_endpoint'
  ) then
    raise exception 'unsupported org secret name: %', normalized_name;
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'secret value is required';
  end if;

  if not exists (select 1 from public.organizations orgs where orgs.id = in_org_id) then
    raise exception 'organization not found: %', in_org_id;
  end if;

  select secrets.id, secrets.vault_secret_id
  into existing_secret_id, existing_vault_secret
  from public.org_secrets secrets
  where secrets.org_id = in_org_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null
  limit 1;

  value_last4 := right(in_secret, 4);
  vault_name := format(
    'org:%s:secret:%s:%s',
    in_org_id::text,
    normalized_name,
    gen_random_uuid()::text
  );
  if existing_secret_id is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_name);

    insert into public.org_secrets (
      org_id,
      name,
      vault_secret_id,
      last4,
      created_by,
      updated_by,
      metadata
    )
    values (
      in_org_id,
      normalized_name,
      vault_secret,
      value_last4,
      actor,
      actor,
      coalesce(in_metadata, '{}'::jsonb)
    )
    returning org_secrets.id into existing_secret_id;
  else
    perform vault.update_secret(existing_vault_secret, in_secret, vault_name, normalized_name);

    update public.org_secrets
    set
      last4 = value_last4,
      updated_by = actor,
      updated_at = now(),
      rotated_at = now(),
      -- Caller metadata replaces the payload, but the migration's
      -- origin_project_id lineage stamp survives every rotation: metadata is
      -- the documented audit surface for the org-only collapse.
      metadata = coalesce(in_metadata, '{}'::jsonb)
        || case
             when org_secrets.metadata ? 'origin_project_id'
               then jsonb_build_object(
                 'origin_project_id', org_secrets.metadata -> 'origin_project_id')
             else '{}'::jsonb
           end
    where org_secrets.id = existing_secret_id;
  end if;

  return query
    select
      secrets.id,
      secrets.org_id,
      secrets.name,
      secrets.last4,
      secrets.created_by,
      secrets.updated_by,
      secrets.created_at,
      secrets.updated_at,
      secrets.rotated_at,
      secrets.last_used_at,
      secrets.revoked_at,
      secrets.revoked_reason,
      secrets.metadata
    from public.org_secrets secrets
    where secrets.id = existing_secret_id;
end;
$$;

create function public.get_org_secret(
  in_org_id uuid,
  in_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text := lower(nullif(btrim(in_name), ''));
  vault_secret uuid;
  secret_value text;
begin
  if in_org_id is null or normalized_name is null then
    raise exception 'org_id and secret name are required';
  end if;

  select secrets.vault_secret_id
  into vault_secret
  from public.org_secrets secrets
  where secrets.org_id = in_org_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null
  limit 1;

  if vault_secret is null then
    return null;
  end if;

  select decrypted.decrypted_secret
  into secret_value
  from vault.decrypted_secrets decrypted
  where decrypted.id = vault_secret
  limit 1;

  update public.org_secrets secrets
  set last_used_at = now()
  where secrets.org_id = in_org_id
    and secrets.name = normalized_name
    and secrets.revoked_at is null;

  return secret_value;
end;
$$;

create function public.list_org_secrets(in_org_id uuid)
returns table (
  name text,
  value text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if in_org_id is null then
    raise exception 'org_id is required';
  end if;

  -- Stamp last_used_at only on rows whose Vault entry resolves, so the
  -- access record never claims a "use" for a secret the caller never got
  -- (e.g. an orphaned vault_secret_id).
  update public.org_secrets secrets
  set last_used_at = now()
  where secrets.org_id = in_org_id
    and secrets.revoked_at is null
    and exists (
      select 1
      from vault.decrypted_secrets decrypted
      where decrypted.id = secrets.vault_secret_id
    );

  return query
    select
      secrets.name,
      decrypted.decrypted_secret as value
    from public.org_secrets secrets
    join vault.decrypted_secrets decrypted
      on decrypted.id = secrets.vault_secret_id
    where secrets.org_id = in_org_id
      and secrets.revoked_at is null;
end;
$$;

create function public.list_org_secret_metadata(in_org_id uuid)
returns table (
  id uuid,
  org_id uuid,
  name text,
  last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz,
  updated_at timestamptz,
  rotated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  metadata jsonb
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    secrets.id,
    secrets.org_id,
    secrets.name,
    secrets.last4,
    secrets.created_by,
    secrets.updated_by,
    secrets.created_at,
    secrets.updated_at,
    secrets.rotated_at,
    secrets.last_used_at,
    secrets.revoked_at,
    secrets.revoked_reason,
    secrets.metadata
  from public.org_secrets secrets
  where secrets.org_id = in_org_id
    and secrets.revoked_at is null
  order by secrets.name;
$$;

revoke all on function public.upsert_org_secret(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_org_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.list_org_secrets(uuid) from public, anon, authenticated;
revoke all on function public.list_org_secret_metadata(uuid) from public, anon, authenticated;
grant execute on function public.upsert_org_secret(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.get_org_secret(uuid, text) to service_role;
grant execute on function public.list_org_secrets(uuid) to service_role;
grant execute on function public.list_org_secret_metadata(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Tenant-provisioning invites name the org they will create.
alter table public.org_invitations rename column project_name to org_name;

drop function public.lookup_org_invitation(text);

create function public.lookup_org_invitation(invite_token text)
returns table (
  email text,
  org_name text,
  invited_role text,
  expires_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    invitations.email,
    -- Join invites name the existing org; tenant invites the org they create.
    coalesce(orgs.name, invitations.org_name),
    invitations.role,
    invitations.expires_at
  from public.org_invitations invitations
  left join public.organizations orgs on orgs.id = invitations.org_id
  where invitations.token = invite_token
    and invitations.accepted_at is null
    and invitations.revoked_at is null
    and invitations.expires_at > now();
$$;

revoke all on function public.lookup_org_invitation(text) from public;
grant execute on function public.lookup_org_invitation(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Provisioning goes org-only. The starter-example copy targets an org and
-- reads the demo-examples org; the signup trigger provisions orgs without a
-- starter project. Copies drop project_id (columns removed below; functions
-- are late-bound so definition order is safe).
drop function public.provision_starter_examples(uuid, uuid);

create function public.provision_starter_examples(target_org_id uuid)
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
    where wm.org_id = '00000000-0000-0000-0000-000000000002'
    order by wm.name
  loop
    -- Copies always start life unbuilt: the demo row's build state, artifact
    -- link, metrics, and error stay behind.
    insert into public.world_models (
      org_id, name, display_name, status, serve_provider,
      serve_model, embed_provider, embed_dim, gepa_budget, trace_adapter,
      config
    )
    values (
      target_org_id, example.name, example.display_name,
      'created', example.serve_provider, example.serve_model,
      example.embed_provider, example.embed_dim, example.gepa_budget,
      example.trace_adapter, example.config
    )
    returning id into copied_wm_id;

    insert into public.trace_uploads (
      org_id, world_model_id, filename, storage_path, byte_size,
      sha256, adapter, trace_count, step_count, status
    )
    select target_org_id, copied_wm_id, uploads.filename,
           uploads.storage_path, uploads.byte_size, uploads.sha256,
           uploads.adapter, uploads.trace_count, uploads.step_count,
           'uploaded'
    from public.trace_uploads uploads
    where uploads.world_model_id = example.id
      -- The seed ships the demo uploads post-build ('ingested', see #269);
      -- both usable states copy, and copies restart as 'uploaded' so the
      -- new org's build ingests them itself.
      and uploads.status in ('uploaded', 'ingested');
  end loop;
end;
$$;

-- Writes into arbitrary orgs: never callable through PostgREST. Only the
-- signup trigger (definer, so it runs as postgres) invokes it.
revoke all on function public.provision_starter_examples(uuid)
  from public, anon, authenticated, service_role;

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

  -- The org IS the workspace: seed it with the demo examples directly so the
  -- app has something to explore after first sign-in.
  perform public.provision_starter_examples(new_org_id);

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Org-scoped replacement indexes (the project-scoped ones drop with the
-- columns), then drop project_id everywhere.
drop index public.world_models_org_id_idx;
create index world_models_org_created_idx
  on public.world_models (org_id, created_at desc);
create index world_models_org_status_idx
  on public.world_models (org_id, status);

drop index public.trace_uploads_org_id_idx;
create index trace_uploads_org_created_idx
  on public.trace_uploads (org_id, created_at desc);

create index wm_sessions_org_status_idx
  on public.wm_sessions (org_id, status);

create index agents_org_status_idx
  on public.agents (org_id, status, created_at desc);

create index agent_opt_runs_org_idx
  on public.agent_opt_runs (org_id);

create index build_jobs_org_idx
  on public.build_jobs (org_id);

drop index public.artifacts_org_id_idx;
create index artifacts_org_kind_idx
  on public.artifacts (org_id, kind, created_at desc);

drop index public.harnesses_org_id_idx;
create index harnesses_org_created_idx
  on public.harnesses (org_id, created_at desc);

alter table public.world_models drop column project_id;
alter table public.trace_uploads drop column project_id;
alter table public.wm_sessions drop column project_id;
alter table public.wm_rollouts drop column project_id;
alter table public.artifacts drop column project_id;
alter table public.agents drop column project_id;
alter table public.agent_opt_runs drop column project_id;
alter table public.harnesses drop column project_id;

-- ---------------------------------------------------------------------------
-- 7. The projects table goes last (policy and trigger drop with it).
drop table public.projects;
