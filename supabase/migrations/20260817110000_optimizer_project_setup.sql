-- Versioned, secret-free setup for the organization-owned WMO Project.
-- The customer API never receives provider_connections ids: the service
-- resolves an explicit safe connection alias to its organization-owned row
-- and passes that internal reference to the atomic function below.

-- Existing provider connections have one row per (organization, provider),
-- so their provider name is already a stable, customer-legible alias. Keep a
-- distinct safe selector because provider alone must not become ambiguous if
-- the connection model later permits multiple accounts for one provider.
alter table public.provider_connections
  add column setup_alias text;

update public.provider_connections
set setup_alias = provider;

alter table public.provider_connections
  alter column setup_alias set not null,
  add constraint provider_connections_setup_alias_check check (
    setup_alias ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
  ),
  add constraint provider_connections_org_setup_alias_key unique (org_id, setup_alias);

comment on column public.provider_connections.setup_alias is
  'Stable non-secret selector exposed by Project setup instead of the internal row or Vault identifier.';

create function public.default_provider_connection_setup_alias()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.setup_alias is null then
    new.setup_alias := new.provider;
  end if;
  return new;
end;
$$;

revoke all on function public.default_provider_connection_setup_alias()
  from public, anon, authenticated;
grant execute on function public.default_provider_connection_setup_alias()
  to service_role;

create trigger provider_connections_default_setup_alias
before insert on public.provider_connections
for each row execute function public.default_provider_connection_setup_alias();

create table public.optimizer_project_setups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique
    references public.optimizer_projects(id) on delete cascade,
  version bigint not null default 1
    constraint optimizer_project_setups_version_positive check (version >= 1),
  system_kind text,
  system_prompt text,
  maximum_model_calls integer,
  run_budget_usd numeric(20, 6),
  max_parallel_requests integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint optimizer_project_setups_system_kind_check check (
    system_kind is null or system_kind = 'builtin_chat'
  ),
  constraint optimizer_project_setups_system_pair_check check (
    (
      system_kind is null
      and system_prompt is null
      and maximum_model_calls is null
    ) or (
      system_kind is not null
      and system_prompt is not null
      and maximum_model_calls is not null
    )
  ),
  constraint optimizer_project_setups_system_prompt_check check (
    system_prompt is null
    or (length(btrim(system_prompt)) between 1 and 20000)
  ),
  constraint optimizer_project_setups_budget_check check (
    run_budget_usd is null
    or (
      run_budget_usd > 0
      and run_budget_usd <> 'NaN'::numeric
      and run_budget_usd <> 'Infinity'::numeric
      and run_budget_usd <> '-Infinity'::numeric
    )
  ),
  constraint optimizer_project_setups_model_calls_check check (
    maximum_model_calls is null
    or maximum_model_calls between 1 and 64
  ),
  constraint optimizer_project_setups_parallel_check check (
    max_parallel_requests is null
    or max_parallel_requests between 1 and 16
  )
);

comment on table public.optimizer_project_setups is
  'Current versioned, secret-free system/budget/execution setup for an optimizer Project.';
comment on column public.optimizer_project_setups.run_budget_usd is
  'Positive finite ceiling for every provider-backed build and optimization call in one attempt; endpoint serving limits are separate.';
comment on column public.optimizer_project_setups.max_parallel_requests is
  'Customer-selected 1..16 bound on concurrent provider dispatches; retry and timeout behavior remain WMO-owned.';
comment on column public.optimizer_project_setups.maximum_model_calls is
  'Canonical built-in chat bound shared with WMO: at most 1..64 model calls per task, default 8 in the typed API.';

create table public.optimizer_project_setup_models (
  id uuid primary key default gen_random_uuid(),
  setup_id uuid not null
    references public.optimizer_project_setups(id) on delete cascade,
  role text not null,
  alias text not null,
  model text not null,
  provider text not null,
  credential_source text not null,
  connection_alias text,
  provider_connection_id uuid
    references public.provider_connections(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint optimizer_project_setup_models_role_check check (
    role in ('world_model', 'judge', 'embedder', 'baseline', 'candidate')
  ),
  constraint optimizer_project_setup_models_alias_check check (
    alias ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
  ),
  constraint optimizer_project_setup_models_model_check check (
    length(btrim(model)) between 1 and 255
  ),
  constraint optimizer_project_setup_models_provider_check check (
    provider in ('openai', 'anthropic')
  ),
  constraint optimizer_project_setup_models_credential_source_check check (
    credential_source in ('byok', 'platform')
  ),
  constraint optimizer_project_setup_models_connection_alias_check check (
    connection_alias is null
    or connection_alias ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
  ),
  constraint optimizer_project_setup_models_credential_pair_check check (
    (
      credential_source = 'byok'
      and connection_alias is not null
    ) or (
      credential_source = 'platform'
      and connection_alias is null
      and provider_connection_id is null
    )
  ),
  constraint optimizer_project_setup_models_alias_key unique (setup_id, alias)
);

create unique index optimizer_project_setup_models_singleton_role_idx
  on public.optimizer_project_setup_models (setup_id, role)
  where role <> 'candidate';

create index optimizer_project_setup_models_provider_connection_idx
  on public.optimizer_project_setup_models (provider_connection_id)
  where provider_connection_id is not null;

comment on table public.optimizer_project_setup_models is
  'Secret-free model-role bindings with explicit Platform/BYOK billing authority; safe BYOK aliases remain while internal provider row ids null on disconnect.';

-- Both tables live in the exposed public schema but are service-API-only.
-- RLS is defense in depth; no anon/authenticated policy or table grant exists.
alter table public.optimizer_project_setups enable row level security;
alter table public.optimizer_project_setup_models enable row level security;

revoke all on public.optimizer_project_setups from public, anon, authenticated;
revoke all on public.optimizer_project_setup_models from public, anon, authenticated;
grant select on public.optimizer_project_setups to service_role;
grant select on public.optimizer_project_setup_models to service_role;

-- Project setup authorization must not pass organization credit through a
-- JSON floating-point number. Return the exact numeric subtraction as text;
-- the replacement RPC repeats this check under the Project lock.
create function public.get_optimizer_project_available_credit(
  in_org_id pg_catalog.uuid
)
returns table (
  available_credit_usd pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
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
      message = 'get_optimizer_project_available_credit requires the service role';
  end if;

  return query select (
    organizations.credit_granted_usd - organizations.billable_spend_usd
  )::pg_catalog.text
  from public.organizations as organizations
  where organizations.id = in_org_id;
end;
$$;

revoke all on function public.get_optimizer_project_available_credit(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_available_credit(pg_catalog.uuid)
  to service_role;

-- One SQL statement gives every caller one MVCC snapshot: a replacement can
-- happen before or after this read, never between the returned parent version
-- and its child bindings. The numeric ceiling crosses PostgREST as canonical
-- fixed-point text so JSON floating point cannot change authorization state.
create function public.get_optimizer_project_setup(
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

create function public.replace_optimizer_project_setup(
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
      or platform_models.provider not in ('openai', 'anthropic')
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
      provider_connection_id pg_catalog.uuid
    )
    where model_rows.role is null
      or model_rows.role not in ('world_model', 'judge', 'embedder', 'baseline', 'candidate')
      or model_rows.alias is null
      or model_rows.alias !~ '^[a-z0-9][a-z0-9_-]{0,62}$'
      or model_rows.model is null
      or pg_catalog.length(pg_catalog.btrim(model_rows.model)) not between 1 and 255
      or model_rows.provider is null
      or model_rows.provider not in ('openai', 'anthropic')
      or model_rows.credential_source is null
      or model_rows.credential_source not in ('byok', 'platform')
      or (
        model_rows.connection_alias is not null
        and model_rows.connection_alias !~ '^[a-z0-9][a-z0-9_-]{0,62}$'
      )
      or (
        model_rows.credential_source = 'byok'
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
    provider_connection_id
  )
  select
    target_setup,
    model_rows.role,
    model_rows.alias,
    pg_catalog.btrim(model_rows.model),
    model_rows.provider,
    model_rows.credential_source,
    model_rows.connection_alias,
    model_rows.provider_connection_id
  from pg_catalog.jsonb_to_recordset(in_models) as model_rows(
    role pg_catalog.text,
    alias pg_catalog.text,
    model pg_catalog.text,
    provider pg_catalog.text,
    credential_source pg_catalog.text,
    connection_alias pg_catalog.text,
    provider_connection_id pg_catalog.uuid
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
