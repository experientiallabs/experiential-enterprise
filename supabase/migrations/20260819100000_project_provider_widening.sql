-- Widen Project setup from the two launch providers to the full provider
-- surface: BYOK connections gain gemini and bedrock, setup model bindings gain
-- gemini, azure_openai, openrouter, bedrock, and local, and each binding may
-- now carry the customer's own OpenAI-compatible endpoint (base_url, local
-- only) plus an explicit capability/price declaration (model_metadata) for
-- providers WMO cannot discover offline.
--
-- The pinned enqueue snapshot moves to schema_version 2: every model object
-- additionally carries base_url, metadata, and the non-secret provider
-- connection config (Azure endpoint/deployments; Bedrock region and access
-- key id). Credentials stay in Vault and never enter the snapshot.

-- 1. BYOK provider connections: admit gemini and bedrock.
alter table public.provider_connections
  drop constraint provider_connections_provider_check;
alter table public.provider_connections
  add constraint provider_connections_provider_check check (
    provider in ('openai', 'anthropic', 'azure_openai', 'openrouter', 'gemini', 'bedrock')
  );

-- 2. Setup model bindings: widened provider set plus the two nullable fields.
alter table public.optimizer_project_setup_models
  add column base_url text,
  add column model_metadata jsonb;

comment on column public.optimizer_project_setup_models.base_url is
  'Customer-owned OpenAI-compatible server endpoint, required for and exclusive to provider=local bindings; hosted providers leave it null.';
comment on column public.optimizer_project_setup_models.model_metadata is
  'Explicit capability/price declaration for providers WMO cannot discover offline; null when the provider publishes its own model table.';

alter table public.optimizer_project_setup_models
  drop constraint optimizer_project_setup_models_provider_check;
alter table public.optimizer_project_setup_models
  add constraint optimizer_project_setup_models_provider_check check (
    provider in (
      'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter', 'bedrock', 'local'
    )
  );

-- Local models are customer infrastructure: always BYOK, never a provider
-- connection row, always an explicit base_url. Hosted providers keep the
-- original byok/platform pairing and never carry a base_url.
alter table public.optimizer_project_setup_models
  drop constraint optimizer_project_setup_models_credential_pair_check;
alter table public.optimizer_project_setup_models
  add constraint optimizer_project_setup_models_credential_pair_check check (
    (
      provider = 'local'
      and credential_source = 'byok'
      and connection_alias is null
      and provider_connection_id is null
      and base_url is not null
    ) or (
      provider <> 'local'
      and base_url is null
      and credential_source = 'byok'
      and connection_alias is not null
    ) or (
      provider <> 'local'
      and base_url is null
      and credential_source = 'platform'
      and connection_alias is null
      and provider_connection_id is null
    )
  );

-- 3. Atomic setup replacement: same signature and flow, widened provider
-- admission, and each in_models element additionally persists base_url and
-- metadata. Platform-fundable providers follow the environment catalog
-- (openai, anthropic, gemini, bedrock); azure_openai and openrouter stay
-- BYOK-only, and local bindings are validated as customer infrastructure.
create or replace function public.replace_optimizer_project_setup(
  in_project_id pg_catalog.uuid,
  in_expected_version pg_catalog.int8,
  in_system_prompt pg_catalog.text,
  in_maximum_model_calls pg_catalog.int4,
  in_run_budget_usd pg_catalog.text,
  in_max_parallel_requests pg_catalog.int4,
  in_models pg_catalog.jsonb,
  in_available_platform_models pg_catalog.jsonb
)
returns table (
  applied pg_catalog.bool,
  current_version pg_catalog.int8,
  snapshot pg_catalog.jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_org pg_catalog.uuid;
  target_setup pg_catalog.uuid;
  stored_version pg_catalog.int8 := 0;
  available_credit pg_catalog.numeric;
  normalized_budget pg_catalog.numeric;
  committed_snapshot pg_catalog.jsonb;
  model_count pg_catalog.int4;
  alias_count pg_catalog.int4;
  platform_model_count pg_catalog.int4;
  platform_model_distinct_count pg_catalog.int4;
begin
  -- The service API performs the end-user admin check. This second gate keeps
  -- the SECURITY DEFINER RPC unavailable to browser roles or accidental
  -- direct calls even if a future grant drifts.
  if coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(
      pg_catalog.current_setting('request.jwt.claims', true),
      ''
    )::pg_catalog.jsonb ->> 'role',
    ''
  ) <> 'service_role'
  and session_user::pg_catalog.text not in ('postgres', 'supabase_admin') then
    raise exception using
      errcode = '42501',
      message = 'replace_optimizer_project_setup requires the service role';
  end if;

  if in_expected_version is null or in_expected_version < 0 then
    raise exception using
      errcode = '23514',
      message = 'expected Project setup version must not be negative';
  end if;

  -- One consistent lock order for every caller: Project, current setup, then
  -- referenced provider rows in UUID order. No external work occurs here.
  select projects.org_id
  into target_org
  from public.optimizer_projects as projects
  where projects.id = in_project_id
    and projects.archived_at is null
  for update;

  if target_org is null then
    raise exception using
      errcode = 'P0002',
      message = 'active Project not found';
  end if;

  select setups.id, setups.version
  into target_setup, stored_version
  from public.optimizer_project_setups as setups
  where setups.project_id = in_project_id
  for update;

  if target_setup is null then
    stored_version := 0;
  end if;
  if stored_version <> in_expected_version then
    return query select false, stored_version, null::pg_catalog.jsonb;
    return;
  end if;

  if (in_system_prompt is null) <> (in_maximum_model_calls is null) then
    raise exception using
      errcode = '23514',
      message = 'built-in chat prompt and model-call bound must be configured together';
  end if;

  if in_system_prompt is not null and (
    pg_catalog.length(pg_catalog.btrim(in_system_prompt)) < 1
    or pg_catalog.length(pg_catalog.btrim(in_system_prompt)) > 20000
    or in_maximum_model_calls < 1
    or in_maximum_model_calls > 64
  ) then
    raise exception using
      errcode = '23514',
      message = 'invalid built-in chat system configuration';
  end if;

  if in_run_budget_usd is not null then
    begin
      normalized_budget := in_run_budget_usd::pg_catalog.numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception using
          errcode = '23514',
          message = 'run budget must be a positive finite fixed-point number';
    end;
    if normalized_budget <= 0
      or normalized_budget = 'NaN'::pg_catalog.numeric
      or normalized_budget = 'Infinity'::pg_catalog.numeric
      or normalized_budget = '-Infinity'::pg_catalog.numeric
      or pg_catalog.abs(normalized_budget) >= 100000000000000
      or normalized_budget <> pg_catalog.round(normalized_budget, 6)
    then
      raise exception using
        errcode = '23514',
        message = 'run budget must be positive and finite';
    end if;
  end if;

  select organizations.credit_granted_usd - organizations.billable_spend_usd
  into available_credit
  from public.organizations as organizations
  where organizations.id = target_org;

  if available_credit is null then
    raise exception using
      errcode = '23514',
      message = 'organization credit balance is unavailable';
  end if;
  if normalized_budget is not null and normalized_budget > available_credit then
    raise exception using
      errcode = '23514',
      message = 'run budget exceeds available Platform credit';
  end if;

  if in_max_parallel_requests is not null and (
    in_max_parallel_requests < 1 or in_max_parallel_requests > 16
  ) then
    raise exception using
      errcode = '23514',
      message = 'max_parallel_requests is outside the supported bound';
  end if;

  if in_models is null or pg_catalog.jsonb_typeof(in_models) <> 'array' then
    raise exception using
      errcode = '23514',
      message = 'Project setup models must be an array';
  end if;
  if pg_catalog.jsonb_array_length(in_models) > 36 then
    raise exception using
      errcode = '23514',
      message = 'Project setup contains too many model bindings';
  end if;

  if in_available_platform_models is null
    or pg_catalog.jsonb_typeof(in_available_platform_models) <> 'array'
    or pg_catalog.jsonb_array_length(in_available_platform_models) > 64
  then
    raise exception using
      errcode = '23514',
      message = 'available Platform models must be a bounded array';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(in_available_platform_models) as entries(value)
    where pg_catalog.jsonb_typeof(entries.value) <> 'object'
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_object_keys(entries.value)
      ) <> 2
  ) then
    raise exception using
      errcode = '23514',
      message = 'available Platform models contain an invalid entry';
  end if;

  select pg_catalog.count(*)::pg_catalog.int4,
         pg_catalog.count(
           distinct (platform_models.provider, platform_models.model)
         )::pg_catalog.int4
  into platform_model_count, platform_model_distinct_count
  from pg_catalog.jsonb_to_recordset(in_available_platform_models) as platform_models(
    provider pg_catalog.text,
    model pg_catalog.text
  );

  if platform_model_count <> platform_model_distinct_count or exists (
    select 1
    from pg_catalog.jsonb_to_recordset(in_available_platform_models) as platform_models(
      provider pg_catalog.text,
      model pg_catalog.text
    )
    where platform_models.provider is null
      or platform_models.provider not in ('openai', 'anthropic', 'gemini', 'bedrock')
      or platform_models.model is null
      or pg_catalog.length(pg_catalog.btrim(platform_models.model)) not between 1 and 255
  ) then
    raise exception using
      errcode = '23514',
      message = 'available Platform models contain an invalid identity';
  end if;

  select pg_catalog.count(*)::pg_catalog.int4,
         pg_catalog.count(distinct model_rows.alias)::pg_catalog.int4
  into model_count, alias_count
  from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
    role pg_catalog.text,
    alias pg_catalog.text,
    model pg_catalog.text,
    provider pg_catalog.text,
    credential_source pg_catalog.text,
    connection_alias pg_catalog.text,
    provider_connection_id pg_catalog.uuid
  );

  if model_count <> alias_count then
    raise exception using
      errcode = '23514',
      message = 'Project setup model aliases must be unique';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
      role pg_catalog.text,
      alias pg_catalog.text,
      model pg_catalog.text,
      provider pg_catalog.text,
      credential_source pg_catalog.text,
      connection_alias pg_catalog.text,
      provider_connection_id pg_catalog.uuid,
      base_url pg_catalog.text,
      metadata pg_catalog.jsonb
    )
    where model_rows.role is null
      or model_rows.role not in ('world_model', 'judge', 'embedder', 'baseline', 'candidate')
      or model_rows.alias is null
      or model_rows.alias !~ '^[a-z0-9][a-z0-9_-]{0,62}$'
      or model_rows.model is null
      or pg_catalog.length(pg_catalog.btrim(model_rows.model)) not between 1 and 255
      or model_rows.provider is null
      or model_rows.provider not in (
        'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter', 'bedrock', 'local'
      )
      or model_rows.credential_source is null
      or model_rows.credential_source not in ('byok', 'platform')
      or (
        model_rows.connection_alias is not null
        and model_rows.connection_alias !~ '^[a-z0-9][a-z0-9_-]{0,62}$'
      )
      -- Local models are customer infrastructure: BYOK without a provider
      -- connection, and their base_url is required and non-blank.
      or (
        model_rows.provider = 'local'
        and (
          model_rows.credential_source <> 'byok'
          or model_rows.connection_alias is not null
          or model_rows.provider_connection_id is not null
          or model_rows.base_url is null
          or pg_catalog.length(pg_catalog.btrim(model_rows.base_url)) not between 1 and 2048
        )
      )
      or (
        model_rows.provider <> 'local'
        and model_rows.base_url is not null
      )
      or (
        model_rows.metadata is not null
        and model_rows.metadata <> 'null'::pg_catalog.jsonb
        and pg_catalog.jsonb_typeof(model_rows.metadata) <> 'object'
      )
      or (
        model_rows.credential_source = 'byok'
        and model_rows.provider <> 'local'
        and (
          model_rows.provider_connection_id is null
          or model_rows.connection_alias is null
        )
      )
      or (
        model_rows.credential_source = 'platform'
        and (
          model_rows.provider_connection_id is not null
          or model_rows.connection_alias is not null
        )
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Project setup contains an invalid model binding';
  end if;

  if exists (
    select model_rows.role
    from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
      role pg_catalog.text,
      alias pg_catalog.text,
      model pg_catalog.text,
      provider pg_catalog.text,
      credential_source pg_catalog.text,
      connection_alias pg_catalog.text,
      provider_connection_id pg_catalog.uuid
    )
    group by model_rows.role
    having (
      model_rows.role = 'candidate' and pg_catalog.count(*) > 32
    ) or (
      model_rows.role <> 'candidate' and pg_catalog.count(*) > 1
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Project setup model role cardinality is invalid';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
      role pg_catalog.text,
      alias pg_catalog.text,
      model pg_catalog.text,
      provider pg_catalog.text,
      credential_source pg_catalog.text,
      connection_alias pg_catalog.text,
      provider_connection_id pg_catalog.uuid
    )
    where model_rows.credential_source = 'platform'
      and not exists (
        select 1
        from pg_catalog.jsonb_to_recordset(in_available_platform_models) as platform_models(
          provider pg_catalog.text,
          model pg_catalog.text
        )
        where platform_models.provider = model_rows.provider
          and platform_models.model = model_rows.model
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Project setup references an unavailable Platform model';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
      role pg_catalog.text,
      alias pg_catalog.text,
      model pg_catalog.text,
      provider pg_catalog.text,
      credential_source pg_catalog.text,
      connection_alias pg_catalog.text,
      provider_connection_id pg_catalog.uuid
    )
    where model_rows.credential_source = 'byok'
      and model_rows.provider <> 'local'
      and not exists (
        select 1
        from public.provider_connections as connections
        where connections.id = model_rows.provider_connection_id
          and connections.org_id = target_org
          and connections.provider = model_rows.provider
          and connections.setup_alias = model_rows.connection_alias
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Project setup references an unavailable provider connection';
  end if;

  perform 1
  from public.provider_connections as connections
  join pg_catalog.jsonb_to_recordset(in_models) as model_rows(
    role pg_catalog.text,
    alias pg_catalog.text,
    model pg_catalog.text,
    provider pg_catalog.text,
    credential_source pg_catalog.text,
    connection_alias pg_catalog.text,
    provider_connection_id pg_catalog.uuid
  ) on model_rows.provider_connection_id = connections.id
  order by connections.id
  for key share of connections;

  if target_setup is null then
    insert into public.optimizer_project_setups (
      project_id,
      version,
      system_kind,
      system_prompt,
      maximum_model_calls,
      run_budget_usd,
      max_parallel_requests
    ) values (
      in_project_id,
      1,
      case when in_system_prompt is null then null else 'builtin_chat' end,
      pg_catalog.btrim(in_system_prompt),
      in_maximum_model_calls,
      normalized_budget,
      in_max_parallel_requests
    )
    returning optimizer_project_setups.id, optimizer_project_setups.version
    into target_setup, stored_version;
  else
    update public.optimizer_project_setups as setups
    set version = setups.version + 1,
        system_kind = case when in_system_prompt is null then null else 'builtin_chat' end,
        system_prompt = pg_catalog.btrim(in_system_prompt),
        maximum_model_calls = in_maximum_model_calls,
        run_budget_usd = normalized_budget,
        max_parallel_requests = in_max_parallel_requests,
        updated_at = pg_catalog.now()
    where setups.id = target_setup
    returning setups.version into stored_version;
  end if;

  delete from public.optimizer_project_setup_models as existing
  where existing.setup_id = target_setup;

  insert into public.optimizer_project_setup_models (
    setup_id,
    role,
    alias,
    model,
    provider,
    credential_source,
    connection_alias,
    provider_connection_id,
    base_url,
    model_metadata
  )
  select
    target_setup,
    model_rows.role,
    model_rows.alias,
    pg_catalog.btrim(model_rows.model),
    model_rows.provider,
    model_rows.credential_source,
    model_rows.connection_alias,
    model_rows.provider_connection_id,
    nullif(pg_catalog.btrim(model_rows.base_url), ''),
    -- jsonb_to_recordset yields SQL NULL for an absent key; nullif folds an
    -- explicit JSON null to the same stored SQL NULL.
    nullif(model_rows.metadata, 'null'::pg_catalog.jsonb)
  from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
    role pg_catalog.text,
    alias pg_catalog.text,
    model pg_catalog.text,
    provider pg_catalog.text,
    credential_source pg_catalog.text,
    connection_alias pg_catalog.text,
    provider_connection_id pg_catalog.uuid,
    base_url pg_catalog.text,
    metadata pg_catalog.jsonb
  );

  select pg_catalog.to_jsonb(snapshot_rows)
  into committed_snapshot
  from public.get_optimizer_project_setup(in_project_id) as snapshot_rows;

  if committed_snapshot is null then
    raise exception using
      errcode = 'P0002',
      message = 'committed Project setup snapshot is unavailable';
  end if;

  return query select true, stored_version, committed_snapshot;
end;
$$;

revoke all on function public.replace_optimizer_project_setup(
  pg_catalog.uuid,
  pg_catalog.int8,
  pg_catalog.text,
  pg_catalog.int4,
  pg_catalog.text,
  pg_catalog.int4,
  pg_catalog.jsonb,
  pg_catalog.jsonb
) from public, anon, authenticated;

grant execute on function public.replace_optimizer_project_setup(
  pg_catalog.uuid,
  pg_catalog.int8,
  pg_catalog.text,
  pg_catalog.int4,
  pg_catalog.text,
  pg_catalog.int4,
  pg_catalog.jsonb,
  pg_catalog.jsonb
) to service_role;

-- 4. Snapshot reader: each model row object additionally carries base_url and
-- metadata. Same single-statement MVCC shape as before.
create or replace function public.get_optimizer_project_setup(
  in_project_id pg_catalog.uuid
)
returns table (
  id pg_catalog.uuid,
  project_id pg_catalog.uuid,
  version pg_catalog.int8,
  system_kind pg_catalog.text,
  system_prompt pg_catalog.text,
  maximum_model_calls pg_catalog.int4,
  run_budget_usd pg_catalog.text,
  max_parallel_requests pg_catalog.int4,
  created_at pg_catalog.timestamptz,
  updated_at pg_catalog.timestamptz,
  models pg_catalog.jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    setups.id,
    setups.project_id,
    setups.version,
    setups.system_kind,
    setups.system_prompt,
    setups.maximum_model_calls,
    setups.run_budget_usd::pg_catalog.text,
    setups.max_parallel_requests,
    setups.created_at,
    setups.updated_at,
    coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', model_rows.id,
            'setup_id', model_rows.setup_id,
            'role', model_rows.role,
            'alias', model_rows.alias,
            'model', model_rows.model,
            'provider', model_rows.provider,
            'credential_source', model_rows.credential_source,
            'connection_alias', model_rows.connection_alias,
            'provider_connection_id', model_rows.provider_connection_id,
            'base_url', model_rows.base_url,
            'metadata', model_rows.model_metadata,
            'created_at', model_rows.created_at
          ) order by model_rows.role, model_rows.alias
        )
        from public.optimizer_project_setup_models as model_rows
        where model_rows.setup_id = setups.id
      ),
      '[]'::pg_catalog.jsonb
    )
  from public.optimizer_project_setups as setups
  where setups.project_id = in_project_id;
$$;

revoke all on function public.get_optimizer_project_setup(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_setup(pg_catalog.uuid)
  to service_role;

-- 5. Enqueue pinning: schema_version 2. Each pinned model object additionally
-- carries base_url, metadata, and the non-secret connection config resolved
-- from the referenced provider_connections row (null without one). Internal
-- alias hashing, ordering, and every other key are unchanged from v1.
create or replace function public.enqueue_optimizer_project_wmo_job(
  p_project_id pg_catalog.uuid,
  p_wmo_revision pg_catalog.text,
  p_available_platform_models pg_catalog.jsonb
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.optimizer_projects%rowtype;
  v_source public.optimizer_project_trace_sources%rowtype;
  v_source_object public.optimizer_project_trace_source_objects%rowtype;
  v_setup public.optimizer_project_setups%rowtype;
  v_job public.optimizer_project_jobs%rowtype;
  v_models pg_catalog.jsonb;
  v_snapshot pg_catalog.jsonb;
  v_model_count pg_catalog.int4;
  v_candidate_count pg_catalog.int4;
  v_platform_model_count pg_catalog.int4;
  v_platform_model_distinct_count pg_catalog.int4;
  v_other_reservations pg_catalog.numeric;
  v_available_credit pg_catalog.numeric;
  v_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_wmo_revision is null or p_wmo_revision !~ '^[0-9a-f]{40}$' then
    raise exception 'invalid WMO revision' using errcode = '22023';
  end if;
  if p_available_platform_models is null
     or pg_catalog.jsonb_typeof(p_available_platform_models) <> 'array'
     or pg_catalog.jsonb_array_length(p_available_platform_models) > 64
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(p_available_platform_models) as entries(value)
       where pg_catalog.jsonb_typeof(entries.value) <> 'object'
         or (
           select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entries.value)
         ) <> 2
     ) then
    raise exception 'invalid available Platform model catalog' using errcode = '22023';
  end if;
  select
    pg_catalog.count(*)::pg_catalog.int4,
    pg_catalog.count(
      distinct (platform_models.provider, platform_models.model)
    )::pg_catalog.int4
  into v_platform_model_count, v_platform_model_distinct_count
  from pg_catalog.jsonb_to_recordset(p_available_platform_models) as platform_models(
    provider pg_catalog.text,
    model pg_catalog.text
  );
  if v_platform_model_count <> v_platform_model_distinct_count
     or exists (
       select 1
       from pg_catalog.jsonb_to_recordset(p_available_platform_models) as platform_models(
         provider pg_catalog.text,
         model pg_catalog.text
       )
       where platform_models.provider is null
          or platform_models.provider not in ('openai', 'anthropic', 'gemini', 'bedrock')
          or platform_models.model is null
          or pg_catalog.char_length(pg_catalog.btrim(platform_models.model)) not between 1 and 255
     ) then
    raise exception 'invalid available Platform model identity' using errcode = '22023';
  end if;

  select projects.* into v_project
  from public.optimizer_projects as projects
  where projects.id = p_project_id and projects.archived_at is null
  for update;
  if v_project.id is null then
    raise exception 'active Project does not exist' using errcode = 'P0002';
  end if;

  perform 1 from public.organizations as organizations
  where organizations.id = v_project.org_id for update;

  select sources.* into v_source
  from public.optimizer_project_trace_current_sources as current_sources
  join public.optimizer_project_trace_sources as sources
    on sources.id = current_sources.source_id
   and sources.project_id = current_sources.project_id
   and sources.org_id = current_sources.org_id
  where current_sources.project_id = p_project_id;
  if v_source.id is null then
    raise exception 'Project trace source is missing' using errcode = '23514';
  end if;
  select objects.* into v_source_object
  from public.optimizer_project_trace_source_objects as objects
  where objects.source_id = v_source.id;
  if v_source_object.source_id is null then
    raise exception 'Project trace source object is missing' using errcode = '23514';
  end if;

  select setups.* into v_setup
  from public.optimizer_project_setups as setups
  where setups.project_id = p_project_id
  for update;
  if v_setup.id is null
     or v_setup.system_kind <> 'builtin_chat'
     or v_setup.system_prompt is null
     or v_setup.maximum_model_calls is null
     or v_setup.run_budget_usd is null
     or v_setup.max_parallel_requests is null then
    raise exception 'Project setup is incomplete' using errcode = '23514';
  end if;

  select
    pg_catalog.count(*)::pg_catalog.int4,
    pg_catalog.count(*) filter (where models.role = 'candidate')::pg_catalog.int4
  into v_model_count, v_candidate_count
  from public.optimizer_project_setup_models as models
  where models.setup_id = v_setup.id;
  if v_model_count <> v_candidate_count + 4 or v_candidate_count < 2 then
    raise exception 'Project setup model roles are incomplete' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.optimizer_project_setup_models as models
    where models.setup_id = v_setup.id
      and models.credential_source = 'byok'
      -- Local models are BYOK customer infrastructure with no connection row.
      and models.provider <> 'local'
      and not exists (
        select 1 from public.provider_connections as connections
        where connections.id = models.provider_connection_id
          and connections.org_id = v_project.org_id
          and connections.provider = models.provider
          and connections.setup_alias = models.connection_alias
      )
  ) then
    raise exception 'Project setup provider connection is unavailable' using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.optimizer_project_setup_models as models
    where models.setup_id = v_setup.id
      and models.credential_source = 'platform'
      and not exists (
        select 1
        from pg_catalog.jsonb_to_recordset(p_available_platform_models) as platform_models(
          provider pg_catalog.text,
          model pg_catalog.text
        )
        where platform_models.provider = models.provider
          and platform_models.model = models.model
      )
  ) then
    raise exception 'Project setup Platform model is unavailable' using errcode = '23514';
  end if;

  select coalesce(
    pg_catalog.sum(reservations.ceiling_usd - reservations.total_spend_usd),
    0
  )
  into v_other_reservations
  from public.optimizer_project_credit_reservations as reservations
  where reservations.org_id = v_project.org_id and reservations.state = 'reserved';
  select organizations.credit_granted_usd - organizations.billable_spend_usd
  into v_available_credit
  from public.organizations as organizations
  where organizations.id = v_project.org_id;
  if v_available_credit is null
     or v_setup.run_budget_usd + v_other_reservations > v_available_credit then
    raise exception 'Project ceiling exceeds unreserved Platform credit' using errcode = '23514';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'role', models.role,
      'public_alias', models.alias,
      'internal_alias',
        'model-' || pg_catalog.replace(models.role, '_', '-') || '-' ||
        pg_catalog.substr(
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                models.role || pg_catalog.chr(31) || models.alias || pg_catalog.chr(31) ||
                models.provider || pg_catalog.chr(31) || models.model || pg_catalog.chr(31) ||
                models.credential_source || pg_catalog.chr(31) ||
                coalesce(models.connection_alias, ''),
                'UTF8'
              )
            ),
            'hex'
          ),
          1,
          24
        ),
      'model', models.model,
      'provider', models.provider,
      'base_url', models.base_url,
      'metadata', models.model_metadata,
      'credential_source', models.credential_source,
      'connection_alias', models.connection_alias,
      'internal_connection_alias',
        -- base_url joins the identity so two local bindings addressing
        -- different servers pin two distinct WMO connections instead of the
        -- last base_url silently claiming both.
        'connection-' || models.credential_source || '-' || models.provider || '-' ||
        pg_catalog.substr(
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                models.provider || pg_catalog.chr(31) || models.credential_source ||
                pg_catalog.chr(31) || coalesce(models.connection_alias, '') ||
                pg_catalog.chr(31) || coalesce(models.base_url, ''),
                'UTF8'
              )
            ),
            'hex'
          ),
          1,
          24
        ),
      -- Non-secret provider config only (Azure endpoint/deployments, Bedrock
      -- region and access key id); credentials stay in Vault and are resolved
      -- transiently through the release RPCs.
      'connection_config', (
        select pc.config
        from public.provider_connections as pc
        where pc.id = models.provider_connection_id
      )
    ) order by
      case models.role
        when 'world_model' then 1
        when 'judge' then 2
        when 'embedder' then 3
        when 'baseline' then 4
        else 5
      end,
      models.alias
  ) into v_models
  from public.optimizer_project_setup_models as models
  where models.setup_id = v_setup.id;

  v_snapshot := pg_catalog.jsonb_build_object(
    'schema_version', 2,
    'setup_version', v_setup.version,
    'system', pg_catalog.jsonb_build_object(
      'kind', v_setup.system_kind,
      'system_prompt', v_setup.system_prompt,
      'maximum_model_calls', v_setup.maximum_model_calls
    ),
    'models', v_models,
    'run_budget_usd', v_setup.run_budget_usd::pg_catalog.text,
    'execution', pg_catalog.jsonb_build_object(
      'max_parallel_requests', v_setup.max_parallel_requests
    )
  );

  insert into public.optimizer_project_jobs(project_id)
  values (p_project_id)
  returning * into v_job;

  insert into public.optimizer_project_job_inputs (
    job_id, project_id, org_id,
    source_id, source_kind, source_label, source_sha256, source_byte_size,
    source_content_type, source_storage_bucket, source_storage_path,
    setup_id, setup_version, setup_snapshot, setup_sha256, ceiling_usd,
    wmo_revision, wmo_project_id, wmo_source_id, wmo_attempt_id,
    authority_sha256, attempt_created_at
  ) values (
    v_job.id, p_project_id, v_project.org_id,
    v_source.id, v_source.source_kind, v_source.source_label, v_source.sha256,
    v_source.byte_size, v_source.content_type, v_source_object.storage_bucket,
    v_source_object.storage_path,
    v_setup.id, v_setup.version, v_snapshot,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::pg_catalog.text, 'UTF8')), 'hex'),
    v_setup.run_budget_usd,
    p_wmo_revision,
    'platform-project-' || pg_catalog.replace(p_project_id::pg_catalog.text, '-', ''),
    'platform-source-' || pg_catalog.replace(v_source.id::pg_catalog.text, '-', ''),
    'platform-attempt-' || pg_catalog.replace(v_job.id::pg_catalog.text, '-', ''),
    pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '') ||
      pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', ''),
    v_now
  );

  insert into public.optimizer_project_credit_reservations(job_id, org_id, ceiling_usd)
  values (v_job.id, v_project.org_id, v_setup.run_budget_usd);

  insert into public.optimizer_project_current_jobs(project_id, job_id)
  values (p_project_id, v_job.id)
  on conflict (project_id) do update
  set job_id = excluded.job_id, updated_at = pg_catalog.clock_timestamp();

  perform public.optimizer_project_job_append_event(
    v_job.id,
    'queued',
    null,
    pg_catalog.jsonb_build_object('message', 'Project work queued')
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

revoke all on function public.enqueue_optimizer_project_wmo_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
)
  from public, anon, authenticated;
grant execute on function public.enqueue_optimizer_project_wmo_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
)
  to service_role;

-- 6. Credential release: admit every connection-backed provider. 'local' is
-- deliberately excluded — local models are customer infrastructure with no
-- stored credential to release.
create or replace function public.release_optimizer_project_provider_credential(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_provider pg_catalog.text,
  p_connection_alias pg_catalog.text
)
returns table (
  provider pg_catalog.text,
  connection_alias pg_catalog.text,
  config pg_catalog.jsonb,
  credential pg_catalog.text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id pg_catalog.uuid;
  v_connection_id pg_catalog.uuid;
  v_vault_secret_id pg_catalog.uuid;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform public.assert_optimizer_project_wmo_fence(
    p_job_id,
    p_claim_token,
    p_claim_generation
  );
  if p_provider not in (
       'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter', 'bedrock'
     )
     or p_connection_alias is null
     or p_connection_alias !~ '^[a-z0-9][a-z0-9_-]{0,62}$' then
    raise exception 'invalid Project provider selector' using errcode = '22023';
  end if;

  select inputs.org_id into v_org_id
  from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(inputs.setup_snapshot -> 'models') as model_rows
      where model_rows ->> 'provider' = p_provider
        and model_rows ->> 'credential_source' = 'byok'
        and model_rows ->> 'connection_alias' = p_connection_alias
    );
  if v_org_id is null then
    raise exception 'Project provider selector is not pinned to this attempt'
      using errcode = '42501';
  end if;

  select connections.id, connections.vault_secret_id
  into v_connection_id, v_vault_secret_id
  from public.provider_connections as connections
  where connections.org_id = v_org_id
    and connections.provider = p_provider
    and connections.setup_alias = p_connection_alias
  for update;
  if v_connection_id is null then
    raise exception 'Project provider connection is unavailable' using errcode = 'P0002';
  end if;

  update public.provider_connections
  set last_used_at = pg_catalog.clock_timestamp()
  where id = v_connection_id;

  return query
  select
    p_provider,
    p_connection_alias,
    connections.config,
    decrypted.decrypted_secret
  from public.provider_connections as connections
  join vault.decrypted_secrets as decrypted on decrypted.id = v_vault_secret_id
  where connections.id = v_connection_id
    and decrypted.decrypted_secret is not null;
  if not found then
    raise exception 'Project provider credential is unavailable' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.release_optimizer_project_provider_credential(
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.int8,
  pg_catalog.text,
  pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.release_optimizer_project_provider_credential(
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.int8,
  pg_catalog.text,
  pg_catalog.text
) to service_role;

create or replace function public.release_optimizer_project_provider_credential_revision(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_provider pg_catalog.text,
  p_connection_alias pg_catalog.text
)
returns table (
  provider pg_catalog.text,
  connection_alias pg_catalog.text,
  config pg_catalog.jsonb,
  credential pg_catalog.text,
  provider_connection_id pg_catalog.uuid,
  serving_revision pg_catalog.int8
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id pg_catalog.uuid;
  v_connection_id pg_catalog.uuid;
  v_vault_secret_id pg_catalog.uuid;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform public.assert_optimizer_project_wmo_fence(
    p_job_id, p_claim_token, p_claim_generation
  );
  if p_provider not in (
       'openai', 'anthropic', 'gemini', 'azure_openai', 'openrouter', 'bedrock'
     )
     or p_connection_alias is null
     or p_connection_alias !~ '^[a-z0-9][a-z0-9_-]{0,62}$' then
    raise exception 'invalid Project provider selector' using errcode = '22023';
  end if;
  select inputs.org_id into v_org_id
  from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(inputs.setup_snapshot -> 'models') as models(value)
      where models.value ->> 'provider' = p_provider
        and models.value ->> 'credential_source' = 'byok'
        and models.value ->> 'connection_alias' = p_connection_alias
    );
  if v_org_id is null then
    raise exception 'Project provider selector is not pinned to this attempt'
      using errcode = '42501';
  end if;
  select connections.id, connections.vault_secret_id
  into v_connection_id, v_vault_secret_id
  from public.provider_connections as connections
  where connections.org_id = v_org_id
    and connections.provider = p_provider
    and connections.setup_alias = p_connection_alias
  for update;
  if v_connection_id is null then
    raise exception 'Project provider connection is unavailable' using errcode = 'P0002';
  end if;
  update public.provider_connections
  set last_used_at = pg_catalog.clock_timestamp()
  where id = v_connection_id;
  return query
  select connections.provider, connections.setup_alias, connections.config,
         decrypted.decrypted_secret, connections.id, connections.serving_revision
  from public.provider_connections as connections
  join vault.decrypted_secrets as decrypted on decrypted.id = connections.vault_secret_id
  where connections.id = v_connection_id and decrypted.decrypted_secret is not null;
  if not found then
    raise exception 'Project provider credential is unavailable' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.release_optimizer_project_provider_credential_revision(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.release_optimizer_project_provider_credential_revision(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.text
) to service_role;

-- 7. The legacy serving lane is fully removed and had one deliberately
-- ungranted operational sealer left behind. Retire the mechanism itself; the
-- sealed provenance rows and their read RPCs remain untouched.
drop function public.seal_legacy_serving_snapshot(text, jsonb);

-- 8. Serving connection-revision projections: pinned local bindings have no
-- provider_connections row by design (the pinned base_url is their whole
-- identity), so they must not count toward the expected connection set. Both
-- the unlocked request-admission projection and the locked activation variant
-- get the same exemption; per-alias credential release stays unchanged and
-- correctly fails closed for local aliases, which are never admitted into a
-- connection-revision set.
create or replace function public.optimizer_project_serving_connection_revisions(
  p_job_id pg_catalog.uuid
)
returns pg_catalog.jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_expected pg_catalog.int8;
  v_found pg_catalog.int8;
  v_revisions pg_catalog.jsonb;
begin
  perform public.optimizer_project_wmo_require_service_role();
  select pg_catalog.count(*) into v_expected
  from public.optimizer_project_job_inputs as inputs
  cross join pg_catalog.jsonb_array_elements(
    inputs.setup_snapshot -> 'models'
  ) as bindings(value)
  where inputs.job_id = p_job_id
    and bindings.value ->> 'role' in ('embedder', 'baseline', 'candidate')
    and bindings.value ->> 'credential_source' = 'byok'
    and bindings.value ->> 'provider' <> 'local';

  select pg_catalog.count(*), coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'role', bindings.value ->> 'role',
        'internal_alias', bindings.value ->> 'internal_alias',
        'provider', bindings.value ->> 'provider',
        'connection_alias', bindings.value ->> 'connection_alias',
        'provider_connection_id', connections.id,
        'serving_revision', connections.serving_revision,
        'config', connections.config
      ) order by bindings.value ->> 'internal_alias'
    ),
    '[]'::pg_catalog.jsonb
  ) into v_found, v_revisions
  from public.optimizer_project_job_inputs as inputs
  cross join pg_catalog.jsonb_array_elements(
    inputs.setup_snapshot -> 'models'
  ) as bindings(value)
  join public.provider_connections as connections
    on connections.org_id = inputs.org_id
   and connections.provider = bindings.value ->> 'provider'
   and connections.setup_alias = bindings.value ->> 'connection_alias'
  where inputs.job_id = p_job_id
    and bindings.value ->> 'role' in ('embedder', 'baseline', 'candidate')
    and bindings.value ->> 'credential_source' = 'byok'
    and bindings.value ->> 'provider' <> 'local';

  if v_found <> v_expected then
    raise exception 'Project serving provider connection is unavailable'
      using errcode = 'P0002';
  end if;
  return v_revisions;
end;
$$;

revoke all on function public.optimizer_project_serving_connection_revisions(
  pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.optimizer_project_serving_connection_revisions(
  pg_catalog.uuid
) to service_role;

create or replace function public.optimizer_project_lock_serving_connection_revisions(
  p_job_id pg_catalog.uuid
)
returns pg_catalog.jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_binding record;
  v_expected pg_catalog.int8;
  v_found pg_catalog.int8 := 0;
  v_revisions pg_catalog.jsonb := '[]'::pg_catalog.jsonb;
begin
  perform public.optimizer_project_wmo_require_service_role();
  select pg_catalog.count(*) into v_expected
  from public.optimizer_project_job_inputs as inputs
  cross join pg_catalog.jsonb_array_elements(
    inputs.setup_snapshot -> 'models'
  ) as bindings(value)
  where inputs.job_id = p_job_id
    and bindings.value ->> 'role' in ('embedder', 'baseline', 'candidate')
    and bindings.value ->> 'credential_source' = 'byok'
    and bindings.value ->> 'provider' <> 'local';

  for v_binding in
    select
      bindings.value ->> 'role' as role,
      bindings.value ->> 'internal_alias' as internal_alias,
      bindings.value ->> 'provider' as provider,
      bindings.value ->> 'connection_alias' as connection_alias,
      connections.id as provider_connection_id,
      connections.serving_revision,
      connections.config
    from public.optimizer_project_job_inputs as inputs
    cross join pg_catalog.jsonb_array_elements(
      inputs.setup_snapshot -> 'models'
    ) as bindings(value)
    join public.provider_connections as connections
      on connections.org_id = inputs.org_id
     and connections.provider = bindings.value ->> 'provider'
     and connections.setup_alias = bindings.value ->> 'connection_alias'
    where inputs.job_id = p_job_id
      and bindings.value ->> 'role' in ('embedder', 'baseline', 'candidate')
      and bindings.value ->> 'credential_source' = 'byok'
      and bindings.value ->> 'provider' <> 'local'
    order by bindings.value ->> 'internal_alias', connections.id
    for update of connections
  loop
    v_found := v_found + 1;
    v_revisions := v_revisions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'role', v_binding.role,
        'internal_alias', v_binding.internal_alias,
        'provider', v_binding.provider,
        'connection_alias', v_binding.connection_alias,
        'provider_connection_id', v_binding.provider_connection_id,
        'serving_revision', v_binding.serving_revision,
        'config', v_binding.config
      )
    );
  end loop;
  if v_found <> v_expected then
    raise exception 'Project serving provider connection is unavailable'
      using errcode = 'P0002';
  end if;
  return v_revisions;
end;
$$;

revoke all on function public.optimizer_project_lock_serving_connection_revisions(
  pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.optimizer_project_lock_serving_connection_revisions(
  pg_catalog.uuid
) to service_role;
