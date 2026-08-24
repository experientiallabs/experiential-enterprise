-- Catalog entries carry a vendored eval-scenario set (the product owner, 2026-07-27:
-- "seed everything - the world model, traces, scenarios"). The set is mined
-- once at seed-generation time and cloned onto every import, so starter and
-- imported models surface scenarios and playground suggestions immediately
-- instead of "Not mined yet" until a rebuild.
--
-- Shape: one jsonb object mirroring ScenarioSetStore.create's inputs -
-- {payload, scenario_count, budget, dropped_count, outcome_mix,
--  corpus_traces, corpus_coverage, coverage_tau, provider, model}.

alter table public.wm_catalog_entries add column scenario_set jsonb;

-- Cross-writer integrity for the honesty stats: every reader treats
-- outcome_mix as an object, so a scalar must be unrepresentable no matter
-- which writer (worker, import route, RPC, seed) produced the row.
alter table public.world_model_scenario_sets
  add constraint world_model_scenario_sets_outcome_mix_is_object
  check (jsonb_typeof(outcome_mix) = 'object');

-- Clone a catalog entry's vendored eval-scenario set onto a model, keyed to
-- its newest catalog-import build job. Fill-if-missing and advisory by
-- design: account provisioning must NEVER abort over a bad vendored payload
-- (one malformed entry would otherwise block every new signup), so a
-- malformed set is skipped with a warning and the model simply reads
-- "not mined yet" until a rebuild.
create function public.ensure_starter_scenario_set(
  in_world_model_id uuid,
  in_entry_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  entry_set jsonb;
  import_job_id uuid;
begin
  select entries.scenario_set into entry_set
  from public.wm_catalog_entries entries
  where entries.id = in_entry_id;

  -- jsonb_typeof also screens a JSON null literal, which `is not null`
  -- alone would let through.
  if entry_set is null or jsonb_typeof(entry_set) <> 'object' then
    return;
  end if;

  if exists (
    select 1
    from public.world_model_scenario_sets sets
    where sets.world_model_id = in_world_model_id
  ) then
    return;
  end if;

  select jobs.id into import_job_id
  from public.build_jobs jobs
  where jobs.world_model_id = in_world_model_id
    and jobs.runtime_backend = 'catalog-import'
  order by jobs.created_at desc
  limit 1;

  if import_job_id is null then
    return;
  end if;

  begin
    insert into public.world_model_scenario_sets (
      world_model_id,
      build_job_id,
      payload,
      scenario_count,
      budget,
      dropped_count,
      outcome_mix,
      corpus_traces,
      corpus_coverage,
      coverage_tau,
      provider,
      model
    )
    values (
      in_world_model_id,
      import_job_id,
      entry_set -> 'payload',
      (entry_set ->> 'scenario_count')::int,
      (entry_set ->> 'budget')::int,
      (entry_set ->> 'dropped_count')::int,
      entry_set -> 'outcome_mix',
      (entry_set ->> 'corpus_traces')::int,
      (entry_set ->> 'corpus_coverage')::double precision,
      (entry_set ->> 'coverage_tau')::double precision,
      entry_set ->> 'provider',
      entry_set ->> 'model'
    );
  exception
    when others then
      -- Missing keys become NULLs (not-null violations), wrong types fail
      -- their casts, and constraint checks reject dishonest stats; all of
      -- them land here instead of aborting the caller's provisioning.
      raise warning 'skipping malformed vendored scenario set on catalog entry %: %',
        in_entry_id, sqlerrm;
  end;
end;
$$;

-- Called only by the definer RPC below (which runs as the owner), never by
-- clients directly.
revoke all on function public.ensure_starter_scenario_set(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ensure_account_starter_world_model: the 20260713120000 body plus the
-- scenario-set clone. Both branches go through ensure_starter_scenario_set:
-- a fresh import clones right after its lineage lands, and an account
-- provisioned BEFORE this migration (starter pointer already set) gets the
-- set backfilled on its next provision call - the deployment seed sweep and
-- the onboarding-page provision route both re-run this idempotently.
create or replace function public.ensure_account_starter_world_model(
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

    -- Backfill for accounts provisioned before scenario vendoring existed.
    if starter.catalog_entry_id is not null then
      perform public.ensure_starter_scenario_set(starter.id, starter.catalog_entry_id);
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

    -- The vendored eval-scenario set travels with the lineage, so the
    -- starter model's scenarios and playground suggestions are live from
    -- first paint.
    perform public.ensure_starter_scenario_set(starter.id, entry.id);
  end if;

  update public.account_workspaces workspaces
  set starter_world_model_id = starter.id
  where workspaces.user_id = in_user_id;

  return next starter;
end;
$$;

-- Belt-and-braces found during QA scoping: world_model_scenario_sets shipped
-- without RLS or explicit grants, leaving it readable through PostgREST by
-- any authenticated session under default public-schema privileges. Every
-- read path is service-role (explabs), so lock it like its sibling tables.
alter table public.world_model_scenario_sets enable row level security;
revoke all on table public.world_model_scenario_sets from public, anon, authenticated;
grant select, insert, update, delete on table public.world_model_scenario_sets to service_role;
