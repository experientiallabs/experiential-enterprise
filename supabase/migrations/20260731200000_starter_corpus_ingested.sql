-- The starter-provisioning clone stamps its corpus ingested, like the API
-- import path already does: the entry's corpus was parsed when the published
-- model was built, and the routing optimizer refuses to cut sweep scenarios
-- from a merely-uploaded corpus ("no ingested trace upload"). Function body
-- is the 20260727130000 definition with only the trace_uploads status fixed.

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
      -- The entry's corpus was parsed when the published model was built and
      -- the entry carries those counts, so the clone is INGESTED data, not a
      -- raw upload awaiting a parse (the routing optimizer only cuts sweep
      -- scenarios from ingested uploads; same rule as the API import path).
      case
        when entry.trace_count is not null and entry.step_count is not null
          then 'ingested'
        else 'uploaded'
      end
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

-- Backfill the clones this path already made: counts are only ever recorded
-- by a completed parse (or copied from a parsed catalog entry), so a counted
-- 'uploaded' row is ingested data mislabeled.
update public.trace_uploads
set status = 'ingested'
where status = 'uploaded'
  and trace_count is not null
  and step_count is not null;
