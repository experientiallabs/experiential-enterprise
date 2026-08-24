-- Exact, restart-safe WMO execution inputs and spend authority for Project jobs.
--
-- Enqueue takes one database snapshot of the immutable trace bytes, versioned
-- secret-free setup, exact ceiling, deterministic WMO identities, and a random
-- attempt authority. Workers never reread mutable current-source or setup
-- pointers. Provider credentials remain in Vault and are resolved transiently
-- through an exact organization/provider/setup-alias tuple.

alter table public.optimizer_project_jobs
  alter column spend_usd type pg_catalog.numeric(20, 6);

alter table public.optimizer_project_jobs
  add constraint optimizer_project_jobs_input_scope_key unique (id, project_id);
alter table public.optimizer_project_setups
  add constraint optimizer_project_setups_input_scope_key unique (id, project_id);

create table public.optimizer_project_job_inputs (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_jobs(id) on delete cascade,
  project_id pg_catalog.uuid not null,
  org_id pg_catalog.uuid not null references public.organizations(id),
  source_id pg_catalog.uuid not null,
  source_kind pg_catalog.text not null,
  source_label pg_catalog.text not null,
  source_sha256 pg_catalog.text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size pg_catalog.int8 not null check (source_byte_size > 0),
  source_content_type pg_catalog.text not null,
  source_storage_bucket pg_catalog.text not null,
  source_storage_path pg_catalog.text not null,
  setup_id pg_catalog.uuid not null,
  setup_version pg_catalog.int8 not null check (setup_version > 0),
  setup_snapshot pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(setup_snapshot) = 'object'
    and pg_catalog.octet_length(setup_snapshot::pg_catalog.text) <= 131072
  ),
  setup_sha256 pg_catalog.text not null check (setup_sha256 ~ '^[0-9a-f]{64}$'),
  ceiling_usd pg_catalog.numeric(20, 6) not null check (ceiling_usd > 0),
  wmo_revision pg_catalog.text not null check (wmo_revision ~ '^[0-9a-f]{40}$'),
  wmo_project_id pg_catalog.text not null check (
    wmo_project_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  wmo_source_id pg_catalog.text not null check (
    wmo_source_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  wmo_attempt_id pg_catalog.text not null unique check (
    wmo_attempt_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  authority_sha256 pg_catalog.text not null unique check (
    authority_sha256 ~ '^[0-9a-f]{64}$'
  ),
  attempt_created_at pg_catalog.timestamptz not null,
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  constraint optimizer_project_job_inputs_job_scope_fkey
    foreign key (job_id, project_id)
    references public.optimizer_project_jobs(id, project_id) on delete cascade,
  constraint optimizer_project_job_inputs_source_scope_fkey
    foreign key (source_id, project_id, org_id)
    references public.optimizer_project_trace_sources(id, project_id, org_id),
  constraint optimizer_project_job_inputs_project_scope_fkey
    foreign key (project_id, org_id)
    references public.optimizer_projects(id, org_id),
  constraint optimizer_project_job_inputs_setup_fkey
    foreign key (setup_id, project_id)
    references public.optimizer_project_setups(id, project_id)
);

create index optimizer_project_job_inputs_project_scope_idx
  on public.optimizer_project_job_inputs(project_id, org_id);
create index optimizer_project_job_inputs_source_scope_idx
  on public.optimizer_project_job_inputs(source_id, project_id, org_id);
create index optimizer_project_job_inputs_setup_scope_idx
  on public.optimizer_project_job_inputs(setup_id, project_id);

create table public.optimizer_project_credit_reservations (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  org_id pg_catalog.uuid not null references public.organizations(id),
  ceiling_usd pg_catalog.numeric(20, 6) not null check (ceiling_usd > 0),
  total_spend_usd pg_catalog.numeric(20, 6) not null default 0 check (
    total_spend_usd >= 0 and total_spend_usd <= ceiling_usd
  ),
  host_managed_spend_usd pg_catalog.numeric(20, 6) not null default 0 check (
    host_managed_spend_usd >= 0 and host_managed_spend_usd <= total_spend_usd
  ),
  state pg_catalog.text not null default 'reserved' check (
    state in ('reserved', 'released')
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  released_at pg_catalog.timestamptz,
  constraint optimizer_project_credit_reservations_release_shape check (
    (state = 'released') = (released_at is not null)
  )
);

create index optimizer_project_credit_reservations_active_org_idx
  on public.optimizer_project_credit_reservations(org_id, job_id)
  where state = 'reserved';

create table public.optimizer_project_wmo_hazards (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  project_id pg_catalog.text not null check (
    project_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  attempt_id pg_catalog.text not null,
  authority_sha256 pg_catalog.text not null check (authority_sha256 ~ '^[0-9a-f]{64}$'),
  stage pg_catalog.text not null check (
    stage in ('building_world_model', 'optimizing_router', 'completing_report')
  ),
  reservations pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(reservations) = 'array'
    and pg_catalog.jsonb_array_length(reservations) between 1 and 12
    and pg_catalog.octet_length(reservations::pg_catalog.text) <= 32768
  ),
  reserved_usd pg_catalog.numeric(20, 6) not null check (reserved_usd >= 0),
  host_managed_reserved_usd pg_catalog.numeric(20, 6) not null check (
    host_managed_reserved_usd >= 0 and host_managed_reserved_usd <= reserved_usd
  ),
  state pg_catalog.text not null default 'active' check (state in ('active', 'ambiguous')),
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  updated_at pg_catalog.timestamptz not null default pg_catalog.now()
);

create table public.optimizer_project_wmo_stage_commits (
  job_id pg_catalog.uuid not null
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  project_id pg_catalog.text not null check (
    project_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  attempt_id pg_catalog.text not null,
  authority_sha256 pg_catalog.text not null check (authority_sha256 ~ '^[0-9a-f]{64}$'),
  stage pg_catalog.text not null check (
    stage in ('building_world_model', 'optimizing_router', 'completing_report')
  ),
  bundle_storage_bucket pg_catalog.text not null,
  bundle_storage_path pg_catalog.text not null,
  bundle_sha256 pg_catalog.text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_size_bytes pg_catalog.int8 not null check (bundle_size_bytes > 0),
  spend_ledger pg_catalog.jsonb not null check (pg_catalog.jsonb_typeof(spend_ledger) = 'object'),
  spend_entries pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(spend_entries) = 'array'
    and pg_catalog.jsonb_array_length(spend_entries) between 1 and 4096
    and pg_catalog.octet_length(spend_entries::pg_catalog.text) <= 2097152
  ),
  spend_total_usd pg_catalog.numeric(20, 6) not null check (spend_total_usd >= 0),
  host_managed_spend_usd pg_catalog.numeric(20, 6) not null check (
    host_managed_spend_usd >= 0 and host_managed_spend_usd <= spend_total_usd
  ),
  policy_id pg_catalog.text,
  report_id pg_catalog.text,
  catalog_artifact_id pg_catalog.text,
  catalog_manifest_sha256 pg_catalog.text,
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  primary key (job_id, stage),
  unique (job_id, bundle_sha256),
  constraint optimizer_project_wmo_stage_commits_result_shape check (
    (
      stage = 'completing_report'
      and policy_id is not null
      and pg_catalog.char_length(policy_id) between 1 and 128
      and policy_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
      and report_id is not null
      and pg_catalog.char_length(report_id) between 1 and 128
      and report_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
      and catalog_artifact_id is not null
      and pg_catalog.char_length(catalog_artifact_id) between 1 and 128
      and catalog_artifact_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
      and catalog_manifest_sha256 is not null
      and catalog_manifest_sha256 ~ '^[0-9a-f]{64}$'
    )
    or (
      stage <> 'completing_report'
      and policy_id is null
      and report_id is null
      and catalog_artifact_id is null
      and catalog_manifest_sha256 is null
    )
  )
);

create table public.optimizer_project_wmo_spend_entries (
  job_id pg_catalog.uuid not null
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  stage pg_catalog.text not null,
  operation_id pg_catalog.text not null check (
    operation_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  component pg_catalog.text not null check (
    component in (
      'world_model', 'candidate', 'judge', 'retrieval_embedding',
      'router_embedding', 'other_provider'
    )
  ),
  billing_source pg_catalog.text not null check (
    billing_source in ('host_managed', 'customer_managed')
  ),
  status pg_catalog.text not null check (
    status in ('observed', 'locally_priced', 'reserved', 'not_incurred')
  ),
  operation_count pg_catalog.int4 not null check (operation_count >= 0),
  amount_usd pg_catalog.numeric(20, 6) not null check (amount_usd >= 0),
  usage pg_catalog.jsonb,
  evidence pg_catalog.jsonb,
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  primary key (job_id, operation_id)
);

create table public.optimizer_project_wmo_failed_ledgers (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  stage pg_catalog.text not null check (
    stage in ('building_world_model', 'optimizing_router', 'completing_report')
  ),
  spend_ledger pg_catalog.jsonb not null check (pg_catalog.jsonb_typeof(spend_ledger) = 'object'),
  spend_entries pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(spend_entries) = 'array'
    and pg_catalog.jsonb_array_length(spend_entries) between 1 and 4096
    and pg_catalog.octet_length(spend_entries::pg_catalog.text) <= 2097152
  ),
  spend_total_usd pg_catalog.numeric(20, 6) not null check (spend_total_usd >= 0),
  created_at pg_catalog.timestamptz not null default pg_catalog.now()
);

create table public.optimizer_project_spend_ledger (
  id pg_catalog.int8 generated always as identity primary key,
  job_id pg_catalog.uuid not null
    references public.optimizer_project_job_inputs(job_id) on delete restrict,
  org_id pg_catalog.uuid not null references public.organizations(id),
  source_key pg_catalog.text not null check (char_length(source_key) between 1 and 128),
  billing_source pg_catalog.text not null check (
    billing_source in ('host_managed', 'customer_managed')
  ),
  amount_usd pg_catalog.numeric(20, 6) not null check (amount_usd >= 0),
  cumulative_usd pg_catalog.numeric(20, 6) not null check (cumulative_usd >= 0),
  created_at pg_catalog.timestamptz not null default pg_catalog.now(),
  unique (job_id, source_key)
);

alter table public.optimizer_project_job_inputs enable row level security;
alter table public.optimizer_project_credit_reservations enable row level security;
alter table public.optimizer_project_wmo_hazards enable row level security;
alter table public.optimizer_project_wmo_stage_commits enable row level security;
alter table public.optimizer_project_wmo_spend_entries enable row level security;
alter table public.optimizer_project_wmo_failed_ledgers enable row level security;
alter table public.optimizer_project_spend_ledger enable row level security;

revoke all on table public.optimizer_project_job_inputs from public, anon, authenticated;
revoke all on table public.optimizer_project_credit_reservations from public, anon, authenticated;
revoke all on table public.optimizer_project_wmo_hazards from public, anon, authenticated;
revoke all on table public.optimizer_project_wmo_stage_commits from public, anon, authenticated;
revoke all on table public.optimizer_project_wmo_spend_entries from public, anon, authenticated;
revoke all on table public.optimizer_project_wmo_failed_ledgers from public, anon, authenticated;
revoke all on table public.optimizer_project_spend_ledger from public, anon, authenticated;

grant select on table public.optimizer_project_job_inputs to service_role;
grant select, update on table public.optimizer_project_credit_reservations to service_role;
grant select on table public.optimizer_project_wmo_hazards to service_role;
grant select on table public.optimizer_project_wmo_stage_commits to service_role;
grant select on table public.optimizer_project_wmo_spend_entries to service_role;
grant select on table public.optimizer_project_wmo_failed_ledgers to service_role;
grant select on table public.optimizer_project_spend_ledger to service_role;

comment on table public.optimizer_project_job_inputs is
  'Immutable enqueue-time source/setup/WMO identity snapshot. Private locators never enter public projections.';
comment on table public.optimizer_project_credit_reservations is
  'Attempt-wide exact ceiling reservations that prevent cross-Project credit overcommit.';
comment on table public.optimizer_project_wmo_hazards is
  'Externally durable paid-operation dispatch boundary; ambiguity is permanent.';
comment on table public.optimizer_project_spend_ledger is
  'Append-only exact Platform billing deltas reconciled to verified WMO ledgers.';

create function public.optimizer_project_wmo_require_service_role()
returns pg_catalog.void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'role',
    ''
  ) <> 'service_role'
  and session_user::pg_catalog.text not in ('postgres', 'supabase_admin') then
    raise exception using errcode = '42501', message = 'Project WMO RPC requires service role';
  end if;
end;
$$;

revoke all on function public.optimizer_project_wmo_require_service_role()
  from public, anon, authenticated;
grant execute on function public.optimizer_project_wmo_require_service_role()
  to service_role;

create function public.reject_optimizer_project_job_input_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'optimizer Project job inputs are immutable' using errcode = '55000';
end;
$$;

create trigger optimizer_project_job_inputs_immutable
before update or delete on public.optimizer_project_job_inputs
for each row execute function public.reject_optimizer_project_job_input_mutation();

create function public.reject_optimizer_project_wmo_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'optimizer Project WMO evidence is append-only' using errcode = '55000';
end;
$$;

create trigger optimizer_project_wmo_stage_commits_append_only
before update or delete on public.optimizer_project_wmo_stage_commits
for each row execute function public.reject_optimizer_project_wmo_evidence_mutation();
create trigger optimizer_project_wmo_spend_entries_append_only
before update or delete on public.optimizer_project_wmo_spend_entries
for each row execute function public.reject_optimizer_project_wmo_evidence_mutation();
create trigger optimizer_project_wmo_failed_ledgers_append_only
before update or delete on public.optimizer_project_wmo_failed_ledgers
for each row execute function public.reject_optimizer_project_wmo_evidence_mutation();
create trigger optimizer_project_spend_ledger_append_only
before update or delete on public.optimizer_project_spend_ledger
for each row execute function public.reject_optimizer_project_wmo_evidence_mutation();

revoke all on function public.reject_optimizer_project_job_input_mutation()
  from public, anon, authenticated;
revoke all on function public.reject_optimizer_project_wmo_evidence_mutation()
  from public, anon, authenticated;

create function public.track_optimizer_project_spend_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.billing_source = 'host_managed' then
    perform public.apply_org_spend_delta(new.org_id, new.amount_usd);
  else
    perform public.apply_org_unbillable_spend_delta(new.org_id, new.amount_usd);
  end if;
  return null;
end;
$$;

create trigger track_optimizer_project_spend_entry
after insert on public.optimizer_project_spend_ledger
for each row execute function public.track_optimizer_project_spend_entry();

revoke all on function public.track_optimizer_project_spend_entry()
  from public, anon, authenticated;

create function public.enqueue_optimizer_project_wmo_job(
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
       where platform_models.provider not in ('openai', 'anthropic')
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
      'credential_source', models.credential_source,
      'connection_alias', models.connection_alias,
      'internal_connection_alias',
        'connection-' || models.credential_source || '-' || models.provider || '-' ||
        pg_catalog.substr(
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                models.provider || pg_catalog.chr(31) || models.credential_source ||
                pg_catalog.chr(31) || coalesce(models.connection_alias, ''),
                'UTF8'
              )
            ),
            'hex'
          ),
          1,
          24
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
    'schema_version', 1,
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

create function public.get_optimizer_project_job_input(p_job_id pg_catalog.uuid)
returns table (
  job_id pg_catalog.uuid,
  project_id pg_catalog.uuid,
  org_id pg_catalog.uuid,
  source_id pg_catalog.uuid,
  source_kind pg_catalog.text,
  source_label pg_catalog.text,
  source_sha256 pg_catalog.text,
  source_byte_size pg_catalog.int8,
  source_content_type pg_catalog.text,
  source_storage_bucket pg_catalog.text,
  source_storage_path pg_catalog.text,
  setup_version pg_catalog.int8,
  setup_snapshot pg_catalog.jsonb,
  setup_sha256 pg_catalog.text,
  ceiling_usd pg_catalog.text,
  wmo_revision pg_catalog.text,
  wmo_project_id pg_catalog.text,
  wmo_source_id pg_catalog.text,
  wmo_attempt_id pg_catalog.text,
  authority_sha256 pg_catalog.text,
  attempt_created_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select
    inputs.job_id,
    inputs.project_id,
    inputs.org_id,
    inputs.source_id,
    inputs.source_kind,
    inputs.source_label,
    inputs.source_sha256,
    inputs.source_byte_size,
    inputs.source_content_type,
    inputs.source_storage_bucket,
    inputs.source_storage_path,
    inputs.setup_version,
    inputs.setup_snapshot,
    inputs.setup_sha256,
    inputs.ceiling_usd::pg_catalog.text,
    inputs.wmo_revision,
    inputs.wmo_project_id,
    inputs.wmo_source_id,
    inputs.wmo_attempt_id,
    inputs.authority_sha256,
    inputs.attempt_created_at
  from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id;
end;
$$;

revoke all on function public.get_optimizer_project_job_input(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_job_input(pg_catalog.uuid)
  to service_role;

create function public.assert_optimizer_project_wmo_fence(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform 1
  from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status = 'running'
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then
    raise exception 'stale Project job fence' using errcode = '40001';
  end if;
end;
$$;

revoke all on function public.assert_optimizer_project_wmo_fence(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.assert_optimizer_project_wmo_fence(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8
) to service_role;

create function public.release_optimizer_project_provider_credential(
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
  if p_provider not in ('openai', 'anthropic')
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

create function public.get_optimizer_project_wmo_attempt_state(p_job_id pg_catalog.uuid)
returns table (
  project_id pg_catalog.text,
  attempt_id pg_catalog.text,
  authority_sha256 pg_catalog.text,
  ceiling_usd pg_catalog.text,
  latest_commit pg_catalog.jsonb,
  terminal pg_catalog.bool
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select
    inputs.wmo_project_id,
    inputs.wmo_attempt_id,
    inputs.authority_sha256,
    inputs.ceiling_usd::pg_catalog.text,
    (
      select pg_catalog.jsonb_build_object(
        'project_id', commits.project_id,
        'attempt_id', commits.attempt_id,
        'authority_sha256', commits.authority_sha256,
        'stage', commits.stage,
        'bundle_sha256', commits.bundle_sha256,
        'bundle_size_bytes', commits.bundle_size_bytes,
        'spend_ledger', commits.spend_ledger,
        'spend_total_usd', commits.spend_total_usd::pg_catalog.text
      )
      from public.optimizer_project_wmo_stage_commits as commits
      where commits.job_id = inputs.job_id
      order by case commits.stage
        when 'building_world_model' then 1
        when 'optimizing_router' then 2
        else 3
      end desc
      limit 1
    ),
    exists (
      select 1 from public.optimizer_project_wmo_stage_commits as commits
      where commits.job_id = inputs.job_id and commits.stage = 'completing_report'
    )
  from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id;
end;
$$;

revoke all on function public.get_optimizer_project_wmo_attempt_state(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_wmo_attempt_state(pg_catalog.uuid)
  to service_role;

create function public.begin_optimizer_project_wmo_hazard(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_project_id pg_catalog.text,
  p_attempt_id pg_catalog.text,
  p_authority_sha256 pg_catalog.text,
  p_stage pg_catalog.text,
  p_reservations pg_catalog.jsonb,
  p_reserved_usd pg_catalog.text,
  p_host_managed_reserved_usd pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input public.optimizer_project_job_inputs%rowtype;
  v_reservation public.optimizer_project_credit_reservations%rowtype;
  v_reserved pg_catalog.numeric;
  v_host_reserved pg_catalog.numeric;
  v_entry_count pg_catalog.int4;
  v_operation_count pg_catalog.int4;
  v_pair_count pg_catalog.int4;
  v_entry_total pg_catalog.numeric;
  v_host_entry_total pg_catalog.numeric;
  v_existing public.optimizer_project_wmo_hazards%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  begin
    v_reserved := p_reserved_usd::pg_catalog.numeric;
    v_host_reserved := p_host_managed_reserved_usd::pg_catalog.numeric;
  exception when others then
    raise exception 'invalid WMO reservation' using errcode = '22023';
  end;
  if v_reserved < 0
     or v_reserved <> pg_catalog.round(v_reserved, 6)
     or v_host_reserved < 0
     or v_host_reserved <> pg_catalog.round(v_host_reserved, 6)
     or v_host_reserved > v_reserved
     or p_reservations is null
     or pg_catalog.jsonb_typeof(p_reservations) <> 'array'
     or pg_catalog.jsonb_array_length(p_reservations) not between 1 and 12
     or p_reservations <> (
       select pg_catalog.jsonb_agg(items.value order by items.value ->> 'operation_id')
       from pg_catalog.jsonb_array_elements(p_reservations) as items(value)
     ) then
    raise exception 'invalid WMO reservation' using errcode = '22023';
  end if;

  select
    pg_catalog.count(*)::pg_catalog.int4,
    pg_catalog.count(distinct entries.operation_id)::pg_catalog.int4,
    pg_catalog.count(distinct (entries.component, entries.billing_source))::pg_catalog.int4,
    coalesce(pg_catalog.sum(entries.amount_usd), 0),
    coalesce(
      pg_catalog.sum(entries.amount_usd) filter (
        where entries.billing_source = 'host_managed'
      ),
      0
    )
  into v_entry_count, v_operation_count, v_pair_count, v_entry_total, v_host_entry_total
  from pg_catalog.jsonb_to_recordset(p_reservations) as entries(
    operation_id pg_catalog.text,
    component pg_catalog.text,
    billing_source pg_catalog.text,
    status pg_catalog.text,
    operation_count pg_catalog.int4,
    amount_usd pg_catalog.numeric,
    usage pg_catalog.jsonb,
    evidence pg_catalog.jsonb
  );
  if v_entry_count <> v_operation_count
     or v_entry_count <> v_pair_count
     or v_entry_total <> v_reserved
     or v_host_entry_total <> v_host_reserved
     or exists (
       select 1
       from pg_catalog.jsonb_to_recordset(p_reservations) as entries(
         operation_id pg_catalog.text,
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text,
         operation_count pg_catalog.int4,
         amount_usd pg_catalog.numeric,
         usage pg_catalog.jsonb,
         evidence pg_catalog.jsonb
       )
       where entries.operation_id is null
          or entries.operation_id !~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
          or entries.component not in (
            'world_model', 'candidate', 'judge', 'retrieval_embedding',
            'router_embedding', 'other_provider'
          )
          or entries.billing_source not in ('host_managed', 'customer_managed')
          or entries.status <> 'reserved'
          or entries.operation_count <= 0
          or entries.amount_usd < 0
          or entries.amount_usd <> pg_catalog.round(entries.amount_usd, 6)
          or entries.usage is not null
          or entries.evidence is not null
     ) then
    raise exception 'invalid source-separated WMO reservations' using errcode = '22023';
  end if;

  perform 1 from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status = 'running'
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then
    raise exception 'stale Project job fence' using errcode = '40001';
  end if;

  select * into v_input from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id;
  if v_input.wmo_project_id <> p_project_id
     or v_input.wmo_attempt_id <> p_attempt_id
     or v_input.authority_sha256 <> p_authority_sha256 then
    raise exception 'WMO attempt authority mismatch' using errcode = '42501';
  end if;

  select * into v_reservation
  from public.optimizer_project_credit_reservations as reservations
  where reservations.job_id = p_job_id for update;
  if v_reservation.state <> 'reserved'
     or v_reservation.total_spend_usd + v_reserved > v_reservation.ceiling_usd then
    raise exception 'WMO reservation exceeds attempt ceiling' using errcode = '23514';
  end if;

  select * into v_existing from public.optimizer_project_wmo_hazards as hazards
  where hazards.job_id = p_job_id for update;
  if v_existing.job_id is null then
    insert into public.optimizer_project_wmo_hazards (
      job_id, project_id, attempt_id, authority_sha256, stage,
      reservations, reserved_usd, host_managed_reserved_usd
    ) values (
      p_job_id, p_project_id, p_attempt_id, p_authority_sha256,
      p_stage, p_reservations, v_reserved, v_host_reserved
    );
  elsif v_existing.project_id <> p_project_id
     or v_existing.attempt_id <> p_attempt_id
     or v_existing.authority_sha256 <> p_authority_sha256
     or v_existing.stage <> p_stage
     or v_existing.reservations <> p_reservations
     or v_existing.reserved_usd <> v_reserved
     or v_existing.host_managed_reserved_usd <> v_host_reserved
     or v_existing.state <> 'active' then
    raise exception 'WMO hazard differs on replay' using errcode = '23505';
  end if;
end;
$$;

revoke all on function public.begin_optimizer_project_wmo_hazard(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.begin_optimizer_project_wmo_hazard(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
) to service_role;

create function public.mark_optimizer_project_wmo_hazard_ambiguous(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_project_id pg_catalog.text,
  p_attempt_id pg_catalog.text,
  p_authority_sha256 pg_catalog.text,
  p_stage pg_catalog.text,
  p_reservations pg_catalog.jsonb,
  p_reserved_usd pg_catalog.text,
  p_host_managed_reserved_usd pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hazard public.optimizer_project_wmo_hazards%rowtype;
  v_reservation public.optimizer_project_credit_reservations%rowtype;
  v_new_total pg_catalog.numeric;
  v_new_host_total pg_catalog.numeric;
  v_new_customer_total pg_catalog.numeric;
  v_reserved pg_catalog.numeric;
  v_host_reserved pg_catalog.numeric;
begin
  perform public.optimizer_project_wmo_require_service_role();
  begin
    v_reserved := p_reserved_usd::pg_catalog.numeric;
    v_host_reserved := p_host_managed_reserved_usd::pg_catalog.numeric;
  exception when others then
    raise exception 'invalid WMO ambiguity reservation' using errcode = '22023';
  end;
  perform 1 from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status = 'running'
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then
    raise exception 'stale Project job fence' using errcode = '40001';
  end if;

  select * into v_reservation
  from public.optimizer_project_credit_reservations as reservations
  where reservations.job_id = p_job_id for update;
  select * into v_hazard
  from public.optimizer_project_wmo_hazards as hazards
  where hazards.job_id = p_job_id for update;
  if v_hazard.job_id is null
     or v_hazard.project_id <> p_project_id
     or v_hazard.attempt_id <> p_attempt_id
     or v_hazard.authority_sha256 <> p_authority_sha256
     or v_hazard.stage <> p_stage
     or v_hazard.reservations <> p_reservations
     or v_hazard.reserved_usd <> v_reserved
     or v_hazard.host_managed_reserved_usd <> v_host_reserved then
    raise exception 'WMO ambiguity differs from active hazard' using errcode = '23514';
  end if;
  if v_hazard.state = 'ambiguous' then
    return;
  end if;

  v_new_total := v_reservation.total_spend_usd + v_hazard.reserved_usd;
  v_new_host_total :=
    v_reservation.host_managed_spend_usd + v_hazard.host_managed_reserved_usd;
  v_new_customer_total := v_new_total - v_new_host_total;
  if v_reservation.state <> 'reserved' or v_new_total > v_reservation.ceiling_usd then
    raise exception 'ambiguous WMO spend exceeds attempt ceiling' using errcode = '23514';
  end if;

  if v_hazard.host_managed_reserved_usd > 0 then
    insert into public.optimizer_project_spend_ledger (
      job_id, org_id, source_key, billing_source, amount_usd, cumulative_usd
    ) values (
      p_job_id, v_reservation.org_id, 'hazard:' || p_stage || ':host_managed',
      'host_managed',
      v_hazard.host_managed_reserved_usd, v_new_host_total
    );
  end if;
  if v_hazard.reserved_usd - v_hazard.host_managed_reserved_usd > 0 then
    insert into public.optimizer_project_spend_ledger (
      job_id, org_id, source_key, billing_source, amount_usd, cumulative_usd
    ) values (
      p_job_id, v_reservation.org_id, 'hazard:' || p_stage || ':customer_managed',
      'customer_managed',
      v_hazard.reserved_usd - v_hazard.host_managed_reserved_usd,
      v_new_customer_total
    );
  end if;
  update public.optimizer_project_credit_reservations
  set total_spend_usd = v_new_total,
      host_managed_spend_usd = v_new_host_total
  where job_id = p_job_id;
  update public.optimizer_project_jobs
  set spend_usd = v_new_total, updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id;
  update public.optimizer_project_wmo_hazards
  set state = 'ambiguous', updated_at = pg_catalog.clock_timestamp()
  where job_id = p_job_id;
end;
$$;

revoke all on function public.mark_optimizer_project_wmo_hazard_ambiguous(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.mark_optimizer_project_wmo_hazard_ambiguous(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
) to service_role;

create function public.get_optimizer_project_wmo_hazard(p_job_id pg_catalog.uuid)
returns table (
  project_id pg_catalog.text,
  attempt_id pg_catalog.text,
  authority_sha256 pg_catalog.text,
  stage pg_catalog.text,
  reservations pg_catalog.jsonb,
  reserved_usd pg_catalog.text,
  host_managed_reserved_usd pg_catalog.text,
  state pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query select
    hazards.project_id,
    hazards.attempt_id,
    hazards.authority_sha256,
    hazards.stage,
    hazards.reservations,
    hazards.reserved_usd::pg_catalog.text,
    hazards.host_managed_reserved_usd::pg_catalog.text,
    hazards.state
  from public.optimizer_project_wmo_hazards as hazards
  where hazards.job_id = p_job_id;
end;
$$;

revoke all on function public.get_optimizer_project_wmo_hazard(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_wmo_hazard(pg_catalog.uuid)
  to service_role;

create function public.commit_optimizer_project_wmo_stage(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_project_id pg_catalog.text,
  p_attempt_id pg_catalog.text,
  p_authority_sha256 pg_catalog.text,
  p_stage pg_catalog.text,
  p_bundle_storage_bucket pg_catalog.text,
  p_bundle_storage_path pg_catalog.text,
  p_bundle_sha256 pg_catalog.text,
  p_bundle_size_bytes pg_catalog.int8,
  p_spend_ledger pg_catalog.jsonb,
  p_spend_total_usd pg_catalog.text,
  p_entries pg_catalog.jsonb,
  p_policy_id pg_catalog.text,
  p_report_id pg_catalog.text,
  p_catalog_artifact_id pg_catalog.text,
  p_catalog_manifest_sha256 pg_catalog.text
)
returns setof public.optimizer_project_wmo_stage_commits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input public.optimizer_project_job_inputs%rowtype;
  v_reservation public.optimizer_project_credit_reservations%rowtype;
  v_hazard public.optimizer_project_wmo_hazards%rowtype;
  v_existing public.optimizer_project_wmo_stage_commits%rowtype;
  v_entry pg_catalog.record;
  v_existing_entry public.optimizer_project_wmo_spend_entries%rowtype;
  v_total pg_catalog.numeric;
  v_entry_total pg_catalog.numeric;
  v_host_total pg_catalog.numeric;
  v_delta pg_catalog.numeric;
  v_host_delta pg_catalog.numeric;
  v_customer_delta pg_catalog.numeric;
  v_expected_order pg_catalog.int4;
  v_stage_order pg_catalog.int4;
begin
  perform public.optimizer_project_wmo_require_service_role();
  begin
    v_total := p_spend_total_usd::pg_catalog.numeric;
  exception when others then
    raise exception 'invalid WMO spend total' using errcode = '22023';
  end;
  if v_total < 0
     or v_total <> pg_catalog.round(v_total, 6)
     or p_bundle_sha256 !~ '^[0-9a-f]{64}$'
     or p_bundle_size_bytes <= 0
     or p_bundle_storage_bucket is null
     or pg_catalog.char_length(pg_catalog.btrim(p_bundle_storage_bucket)) not between 1 and 255
     or p_bundle_storage_path is null
     or pg_catalog.char_length(pg_catalog.btrim(p_bundle_storage_path)) not between 1 and 1024
     or p_bundle_storage_path ~ '(^/|(^|/)\.\.?(/|$)|[[:cntrl:]])'
     or p_spend_ledger is null
     or pg_catalog.jsonb_typeof(p_spend_ledger) <> 'object'
     or p_entries is null
     or pg_catalog.jsonb_typeof(p_entries) <> 'array'
     or pg_catalog.jsonb_array_length(p_entries) not between 1 and 4096
     or pg_catalog.octet_length(p_entries::pg_catalog.text) > 2097152
     or not (
       (
         p_stage = 'completing_report'
         and p_policy_id is not null
         and pg_catalog.char_length(p_policy_id) between 1 and 128
         and p_policy_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
         and p_report_id is not null
         and pg_catalog.char_length(p_report_id) between 1 and 128
         and p_report_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
         and p_catalog_artifact_id is not null
         and pg_catalog.char_length(p_catalog_artifact_id) between 1 and 128
         and p_catalog_artifact_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
         and p_catalog_manifest_sha256 is not null
         and p_catalog_manifest_sha256 ~ '^[0-9a-f]{64}$'
       )
       or (
         p_stage <> 'completing_report'
         and p_policy_id is null
         and p_report_id is null
         and p_catalog_artifact_id is null
         and p_catalog_manifest_sha256 is null
       )
     ) then
    raise exception 'invalid WMO stage commit payload' using errcode = '22023';
  end if;

  perform 1 from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status = 'running'
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then
    raise exception 'stale Project job fence' using errcode = '40001';
  end if;

  select * into v_input from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id;
  if v_input.wmo_project_id <> p_project_id
     or v_input.wmo_attempt_id <> p_attempt_id
     or v_input.authority_sha256 <> p_authority_sha256 then
    raise exception 'WMO stage commit authority mismatch' using errcode = '42501';
  end if;

  select
    coalesce(pg_catalog.sum(entry_rows.amount_usd), 0),
    coalesce(
      pg_catalog.sum(entry_rows.amount_usd) filter (
        where entry_rows.billing_source = 'host_managed'
      ),
      0
    )
  into v_entry_total, v_host_total
  from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(
    operation_id pg_catalog.text,
    component pg_catalog.text,
    billing_source pg_catalog.text,
    status pg_catalog.text,
    operation_count pg_catalog.int4,
    amount_usd pg_catalog.numeric,
    usage pg_catalog.jsonb,
    evidence pg_catalog.jsonb
  );
  if v_entry_total <> v_total
     or v_host_total > v_total
     or p_entries <> (
       select pg_catalog.jsonb_agg(items.value order by items.value ->> 'operation_id')
       from pg_catalog.jsonb_array_elements(p_entries) as items(value)
     )
     or (select pg_catalog.count(*)
         from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(operation_id pg_catalog.text))
        <> (select pg_catalog.count(distinct entry_rows.operation_id)
            from pg_catalog.jsonb_to_recordset(p_entries)
              as entry_rows(operation_id pg_catalog.text))
     or (select pg_catalog.count(distinct entry_rows.component)
         from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(component pg_catalog.text)) <> 6
     or exists (
       select 1 from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(
         operation_id pg_catalog.text,
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text,
         operation_count pg_catalog.int4,
         amount_usd pg_catalog.numeric,
         usage pg_catalog.jsonb,
         evidence pg_catalog.jsonb
       )
       where entry_rows.operation_id is null
          or entry_rows.operation_id !~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
          or entry_rows.component not in (
            'world_model', 'candidate', 'judge', 'retrieval_embedding',
            'router_embedding', 'other_provider'
          )
          or entry_rows.billing_source not in ('host_managed', 'customer_managed')
          or entry_rows.status not in ('observed', 'locally_priced', 'reserved', 'not_incurred')
          or entry_rows.operation_count < 0
          or entry_rows.amount_usd < 0
          or entry_rows.amount_usd <> pg_catalog.round(entry_rows.amount_usd, 6)
          or (
            entry_rows.status = 'not_incurred'
            and (
              entry_rows.operation_count <> 0
              or entry_rows.amount_usd <> 0
              or entry_rows.usage is not null
            )
          )
          or (entry_rows.status <> 'not_incurred' and entry_rows.operation_count = 0)
          or (entry_rows.status = 'locally_priced' and entry_rows.usage is null)
          or (entry_rows.usage is not null and pg_catalog.jsonb_typeof(entry_rows.usage) <> 'object')
          or (
            entry_rows.evidence is not null
            and pg_catalog.jsonb_typeof(entry_rows.evidence) <> 'object'
          )
     )
     or exists (
       select 1
       from pg_catalog.jsonb_to_recordset(p_entries) as zero_entries(
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text
       )
       join pg_catalog.jsonb_to_recordset(p_entries) as incurred_entries(
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text
       ) on incurred_entries.component = zero_entries.component
          and incurred_entries.billing_source = zero_entries.billing_source
       where zero_entries.status = 'not_incurred'
         and incurred_entries.status <> 'not_incurred'
     ) then
    raise exception 'WMO component ledger does not reconcile' using errcode = '23514';
  end if;

  select * into v_existing
  from public.optimizer_project_wmo_stage_commits as commits
  where commits.job_id = p_job_id and commits.stage = p_stage;
  if v_existing.job_id is not null then
    if v_existing.project_id <> p_project_id
       or v_existing.attempt_id <> p_attempt_id
       or v_existing.authority_sha256 <> p_authority_sha256
       or v_existing.bundle_storage_bucket <> p_bundle_storage_bucket
       or v_existing.bundle_storage_path <> p_bundle_storage_path
       or v_existing.bundle_sha256 <> p_bundle_sha256
       or v_existing.bundle_size_bytes <> p_bundle_size_bytes
       or v_existing.spend_ledger <> p_spend_ledger
       or v_existing.spend_entries <> p_entries
       or v_existing.spend_total_usd <> v_total
       or v_existing.host_managed_spend_usd <> v_host_total
       or v_existing.policy_id is distinct from p_policy_id
       or v_existing.report_id is distinct from p_report_id
       or v_existing.catalog_artifact_id is distinct from p_catalog_artifact_id
       or v_existing.catalog_manifest_sha256 is distinct from p_catalog_manifest_sha256 then
      raise exception 'WMO stage commit differs on replay' using errcode = '23505';
    end if;
    return next v_existing;
    return;
  end if;

  v_stage_order := case p_stage
    when 'building_world_model' then 1
    when 'optimizing_router' then 2
    when 'completing_report' then 3
    else 0
  end;
  select coalesce(pg_catalog.max(case commits.stage
    when 'building_world_model' then 1
    when 'optimizing_router' then 2
    else 3
  end), 0) + 1
  into v_expected_order
  from public.optimizer_project_wmo_stage_commits as commits
  where commits.job_id = p_job_id;
  if v_stage_order = 0 or v_stage_order <> v_expected_order then
    raise exception 'WMO stages must commit monotonically' using errcode = '23514';
  end if;

  select * into v_reservation
  from public.optimizer_project_credit_reservations as reservations
  where reservations.job_id = p_job_id for update;
  select * into v_hazard from public.optimizer_project_wmo_hazards as hazards
  where hazards.job_id = p_job_id for update;
  if v_reservation.state <> 'reserved'
     or v_total < v_reservation.total_spend_usd
     or v_total > v_reservation.ceiling_usd
     or v_host_total < v_reservation.host_managed_spend_usd
     or v_total - v_host_total
        < v_reservation.total_spend_usd - v_reservation.host_managed_spend_usd
     or v_hazard.job_id is null
     or v_hazard.state <> 'active'
     or v_hazard.stage <> p_stage
     or v_hazard.project_id <> p_project_id
     or v_hazard.attempt_id <> p_attempt_id
     or v_hazard.authority_sha256 <> p_authority_sha256 then
    raise exception 'WMO stage is not covered by an active authority reservation'
      using errcode = '23514';
  end if;
  v_delta := v_total - v_reservation.total_spend_usd;
  v_host_delta := v_host_total - v_reservation.host_managed_spend_usd;
  v_customer_delta := v_delta - v_host_delta;
  if v_delta > v_hazard.reserved_usd then
    raise exception 'WMO stage spend exceeds its provider reservation' using errcode = '23514';
  end if;
  if v_host_delta > v_hazard.host_managed_reserved_usd
     or v_customer_delta > v_hazard.reserved_usd - v_hazard.host_managed_reserved_usd then
    raise exception 'WMO stage spend source exceeds its provider reservation'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.optimizer_project_wmo_spend_entries as existing_entries
    where existing_entries.job_id = p_job_id
      and existing_entries.status <> 'not_incurred'
      and not exists (
        select 1
        from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(operation_id pg_catalog.text)
        where entry_rows.operation_id = existing_entries.operation_id
      )
  ) then
    raise exception 'WMO cumulative ledger omitted committed spend evidence'
      using errcode = '23514';
  end if;

  for v_entry in
    select * from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(
      operation_id pg_catalog.text,
      component pg_catalog.text,
      billing_source pg_catalog.text,
      status pg_catalog.text,
      operation_count pg_catalog.int4,
      amount_usd pg_catalog.numeric,
      usage pg_catalog.jsonb,
      evidence pg_catalog.jsonb
    ) order by entry_rows.operation_id
  loop
    select * into v_existing_entry
    from public.optimizer_project_wmo_spend_entries as entries
    where entries.job_id = p_job_id and entries.operation_id = v_entry.operation_id;
    if v_existing_entry.job_id is null then
      insert into public.optimizer_project_wmo_spend_entries (
        job_id, stage, operation_id, component, billing_source, status,
        operation_count, amount_usd, usage, evidence
      ) values (
        p_job_id, p_stage, v_entry.operation_id, v_entry.component,
        v_entry.billing_source, v_entry.status,
        v_entry.operation_count, v_entry.amount_usd, v_entry.usage, v_entry.evidence
      );
    elsif v_existing_entry.component <> v_entry.component
       or v_existing_entry.billing_source <> v_entry.billing_source
       or v_existing_entry.status <> v_entry.status
       or v_existing_entry.operation_count <> v_entry.operation_count
       or v_existing_entry.amount_usd <> v_entry.amount_usd
       or v_existing_entry.usage is distinct from v_entry.usage
       or v_existing_entry.evidence is distinct from v_entry.evidence then
      raise exception 'WMO spend entry differs on replay' using errcode = '23505';
    end if;
  end loop;

  insert into public.optimizer_project_wmo_stage_commits (
    job_id, project_id, attempt_id, authority_sha256, stage,
    bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes,
    spend_ledger, spend_entries, spend_total_usd, host_managed_spend_usd,
    policy_id, report_id, catalog_artifact_id, catalog_manifest_sha256
  ) values (
    p_job_id, p_project_id, p_attempt_id, p_authority_sha256, p_stage,
    p_bundle_storage_bucket, p_bundle_storage_path, p_bundle_sha256, p_bundle_size_bytes,
    p_spend_ledger, p_entries, v_total, v_host_total,
    p_policy_id, p_report_id, p_catalog_artifact_id, p_catalog_manifest_sha256
  ) returning * into v_existing;

  if v_host_delta > 0 then
    insert into public.optimizer_project_spend_ledger (
      job_id, org_id, source_key, billing_source, amount_usd, cumulative_usd
    ) values (
      p_job_id, v_reservation.org_id, 'stage:' || p_stage || ':host_managed',
      'host_managed', v_host_delta, v_host_total
    );
  end if;
  if v_customer_delta > 0 then
    insert into public.optimizer_project_spend_ledger (
      job_id, org_id, source_key, billing_source, amount_usd, cumulative_usd
    ) values (
      p_job_id, v_reservation.org_id, 'stage:' || p_stage || ':customer_managed',
      'customer_managed', v_customer_delta, v_total - v_host_total
    );
  end if;
  update public.optimizer_project_credit_reservations
  set total_spend_usd = v_total,
      host_managed_spend_usd = v_host_total
  where job_id = p_job_id;
  update public.optimizer_project_jobs
  set spend_usd = v_total, updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id;
  delete from public.optimizer_project_wmo_hazards
  where job_id = p_job_id and state = 'active';
  perform public.optimizer_project_job_append_event(
    p_job_id,
    'stage_committed',
    p_stage,
    pg_catalog.jsonb_build_object(
      'artifact_kind', 'wmo_project_bundle',
      'sha256', p_bundle_sha256,
      'spend_usd', v_total::pg_catalog.text
    )
  );
  return next v_existing;
end;
$$;

revoke all on function public.commit_optimizer_project_wmo_stage(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.commit_optimizer_project_wmo_stage(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.int8, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text
) to service_role;

create function public.record_optimizer_project_wmo_failed_ledger(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_stage pg_catalog.text,
  p_spend_ledger pg_catalog.jsonb,
  p_spend_total_usd pg_catalog.text,
  p_entries pg_catalog.jsonb
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hazard public.optimizer_project_wmo_hazards%rowtype;
  v_reservation public.optimizer_project_credit_reservations%rowtype;
  v_existing public.optimizer_project_wmo_failed_ledgers%rowtype;
  v_entry pg_catalog.record;
  v_existing_entry public.optimizer_project_wmo_spend_entries%rowtype;
  v_total pg_catalog.numeric;
  v_entry_total pg_catalog.numeric;
  v_host_total pg_catalog.numeric;
begin
  perform public.optimizer_project_wmo_require_service_role();
  begin
    v_total := p_spend_total_usd::pg_catalog.numeric;
  exception when others then
    raise exception 'invalid failed WMO spend total' using errcode = '22023';
  end;
  if v_total < 0
     or v_total <> pg_catalog.round(v_total, 6)
     or p_spend_ledger is null
     or pg_catalog.jsonb_typeof(p_spend_ledger) <> 'object'
     or p_entries is null
     or pg_catalog.jsonb_typeof(p_entries) <> 'array'
     or pg_catalog.jsonb_array_length(p_entries) not between 1 and 4096
     or pg_catalog.octet_length(p_entries::pg_catalog.text) > 2097152 then
    raise exception 'invalid failed WMO ledger payload' using errcode = '22023';
  end if;
  perform 1 from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status = 'running'
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then
    raise exception 'stale Project job fence' using errcode = '40001';
  end if;
  select * into v_reservation from public.optimizer_project_credit_reservations as reservations
  where reservations.job_id = p_job_id for update;
  select * into v_hazard from public.optimizer_project_wmo_hazards as hazards
  where hazards.job_id = p_job_id and hazards.state = 'ambiguous' for update;
  if v_hazard.job_id is null
     or v_hazard.stage <> p_stage
     or v_reservation.job_id is null
     or v_reservation.state <> 'reserved'
     or v_total <> v_reservation.total_spend_usd then
    raise exception 'failed WMO ledger does not match ambiguous spend' using errcode = '23514';
  end if;

  select
    coalesce(pg_catalog.sum(entry_rows.amount_usd), 0),
    coalesce(
      pg_catalog.sum(entry_rows.amount_usd) filter (
        where entry_rows.billing_source = 'host_managed'
      ),
      0
    )
  into v_entry_total, v_host_total
  from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(
    operation_id pg_catalog.text,
    component pg_catalog.text,
    billing_source pg_catalog.text,
    status pg_catalog.text,
    operation_count pg_catalog.int4,
    amount_usd pg_catalog.numeric,
    usage pg_catalog.jsonb,
    evidence pg_catalog.jsonb
  );
  if v_entry_total <> v_total
     or v_host_total <> v_reservation.host_managed_spend_usd
     or p_entries <> (
       select pg_catalog.jsonb_agg(items.value order by items.value ->> 'operation_id')
       from pg_catalog.jsonb_array_elements(p_entries) as items(value)
     )
     or (select pg_catalog.count(*)
         from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(operation_id pg_catalog.text))
        <> (select pg_catalog.count(distinct entry_rows.operation_id)
            from pg_catalog.jsonb_to_recordset(p_entries)
              as entry_rows(operation_id pg_catalog.text))
     or (select pg_catalog.count(distinct entry_rows.component)
         from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(component pg_catalog.text)) <> 6
     or exists (
       select 1 from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(
         operation_id pg_catalog.text,
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text,
         operation_count pg_catalog.int4,
         amount_usd pg_catalog.numeric,
         usage pg_catalog.jsonb,
         evidence pg_catalog.jsonb
       )
       where entry_rows.operation_id is null
          or entry_rows.operation_id !~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
          or entry_rows.component not in (
            'world_model', 'candidate', 'judge', 'retrieval_embedding',
            'router_embedding', 'other_provider'
          )
          or entry_rows.billing_source not in ('host_managed', 'customer_managed')
          or entry_rows.status not in ('observed', 'locally_priced', 'reserved', 'not_incurred')
          or entry_rows.operation_count < 0
          or entry_rows.amount_usd < 0
          or entry_rows.amount_usd <> pg_catalog.round(entry_rows.amount_usd, 6)
          or (
            entry_rows.status = 'not_incurred'
            and (
              entry_rows.operation_count <> 0
              or entry_rows.amount_usd <> 0
              or entry_rows.usage is not null
            )
          )
          or (entry_rows.status <> 'not_incurred' and entry_rows.operation_count = 0)
          or (entry_rows.status = 'locally_priced' and entry_rows.usage is null)
          or (entry_rows.usage is not null and pg_catalog.jsonb_typeof(entry_rows.usage) <> 'object')
          or (
            entry_rows.evidence is not null
            and pg_catalog.jsonb_typeof(entry_rows.evidence) <> 'object'
          )
     )
     or exists (
       select 1
       from pg_catalog.jsonb_to_recordset(p_entries) as zero_entries(
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text
       )
       join pg_catalog.jsonb_to_recordset(p_entries) as incurred_entries(
         component pg_catalog.text,
         billing_source pg_catalog.text,
         status pg_catalog.text
       ) on incurred_entries.component = zero_entries.component
          and incurred_entries.billing_source = zero_entries.billing_source
       where zero_entries.status = 'not_incurred'
         and incurred_entries.status <> 'not_incurred'
     ) then
    raise exception 'failed WMO component ledger does not reconcile' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.optimizer_project_wmo_spend_entries as existing_entries
    where existing_entries.job_id = p_job_id
      and existing_entries.status <> 'not_incurred'
      and not exists (
        select 1
        from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(operation_id pg_catalog.text)
        where entry_rows.operation_id = existing_entries.operation_id
      )
  ) then
    raise exception 'failed WMO cumulative ledger omitted committed spend evidence'
      using errcode = '23514';
  end if;

  select * into v_existing from public.optimizer_project_wmo_failed_ledgers as ledgers
  where ledgers.job_id = p_job_id;
  if v_existing.job_id is not null then
    if v_existing.stage <> p_stage
       or v_existing.spend_ledger <> p_spend_ledger
       or v_existing.spend_entries <> p_entries
       or v_existing.spend_total_usd <> v_total then
      raise exception 'failed WMO ledger differs on replay' using errcode = '23505';
    end if;
    return;
  end if;

  for v_entry in
    select * from pg_catalog.jsonb_to_recordset(p_entries) as entry_rows(
      operation_id pg_catalog.text,
      component pg_catalog.text,
      billing_source pg_catalog.text,
      status pg_catalog.text,
      operation_count pg_catalog.int4,
      amount_usd pg_catalog.numeric,
      usage pg_catalog.jsonb,
      evidence pg_catalog.jsonb
    ) order by entry_rows.operation_id
  loop
    select * into v_existing_entry
    from public.optimizer_project_wmo_spend_entries as entries
    where entries.job_id = p_job_id and entries.operation_id = v_entry.operation_id;
    if v_existing_entry.job_id is null then
      insert into public.optimizer_project_wmo_spend_entries (
        job_id, stage, operation_id, component, billing_source, status,
        operation_count, amount_usd, usage, evidence
      ) values (
        p_job_id, p_stage, v_entry.operation_id, v_entry.component,
        v_entry.billing_source, v_entry.status,
        v_entry.operation_count, v_entry.amount_usd, v_entry.usage, v_entry.evidence
      );
    elsif v_existing_entry.component <> v_entry.component
       or v_existing_entry.billing_source <> v_entry.billing_source
       or v_existing_entry.status <> v_entry.status
       or v_existing_entry.operation_count <> v_entry.operation_count
       or v_existing_entry.amount_usd <> v_entry.amount_usd
       or v_existing_entry.usage is distinct from v_entry.usage
       or v_existing_entry.evidence is distinct from v_entry.evidence then
      raise exception 'failed WMO spend entry differs from committed evidence'
        using errcode = '23505';
    end if;
  end loop;
  insert into public.optimizer_project_wmo_failed_ledgers (
    job_id, stage, spend_ledger, spend_entries, spend_total_usd
  ) values (p_job_id, p_stage, p_spend_ledger, p_entries, v_total);
end;
$$;

revoke all on function public.record_optimizer_project_wmo_failed_ledger(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.record_optimizer_project_wmo_failed_ledger(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.text, pg_catalog.jsonb
) to service_role;

create function public.get_optimizer_project_latest_wmo_bundle(p_job_id pg_catalog.uuid)
returns table (
  stage pg_catalog.text,
  bundle_storage_bucket pg_catalog.text,
  bundle_storage_path pg_catalog.text,
  bundle_sha256 pg_catalog.text,
  bundle_size_bytes pg_catalog.int8,
  spend_total_usd pg_catalog.text,
  policy_id pg_catalog.text,
  report_id pg_catalog.text,
  catalog_artifact_id pg_catalog.text,
  catalog_manifest_sha256 pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select
    commits.stage,
    commits.bundle_storage_bucket,
    commits.bundle_storage_path,
    commits.bundle_sha256,
    commits.bundle_size_bytes,
    commits.spend_total_usd::pg_catalog.text,
    commits.policy_id,
    commits.report_id,
    commits.catalog_artifact_id,
    commits.catalog_manifest_sha256
  from public.optimizer_project_wmo_stage_commits as commits
  where commits.job_id = p_job_id
  order by case commits.stage
    when 'building_world_model' then 1
    when 'optimizing_router' then 2
    else 3
  end desc
  limit 1;
end;
$$;

revoke all on function public.get_optimizer_project_latest_wmo_bundle(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_latest_wmo_bundle(pg_catalog.uuid)
  to service_role;

-- Terminal transitions release only unused authorization. Actual spend is
-- append-only and never refunded by a retry, cancellation, or data deletion.
create or replace function public.finish_optimizer_project_job(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_status pg_catalog.text,
  p_public_error_code pg_catalog.text,
  p_public_error_message pg_catalog.text
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
  v_payload pg_catalog.jsonb;
  v_has_input pg_catalog.bool;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_status not in ('completed', 'failed', 'ambiguous') then
    raise exception 'invalid Project job terminal state' using errcode = '22023';
  end if;
  if p_status = 'completed'
     and (p_public_error_code is not null or p_public_error_message is not null) then
    raise exception 'completed Project job cannot carry an error' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.optimizer_project_job_inputs as inputs where inputs.job_id = p_job_id
  ) into v_has_input;
  if v_has_input and p_status = 'completed' and not exists (
    select 1 from public.optimizer_project_wmo_stage_commits as commits
    where commits.job_id = p_job_id and commits.stage = 'completing_report'
  ) then
    raise exception 'completed Project job requires a committed WMO report stage'
      using errcode = '23514';
  end if;
  if v_has_input and p_status = 'ambiguous' and not exists (
    select 1 from public.optimizer_project_wmo_hazards as hazards
    join public.optimizer_project_wmo_failed_ledgers as ledgers using (job_id)
    where hazards.job_id = p_job_id and hazards.state = 'ambiguous'
  ) then
    raise exception 'ambiguous Project job requires reconciled failed WMO evidence'
      using errcode = '23514';
  end if;
  if v_has_input and p_status <> 'ambiguous' and exists (
    select 1 from public.optimizer_project_wmo_hazards as hazards
    where hazards.job_id = p_job_id and hazards.state = 'ambiguous'
  ) then
    raise exception 'ambiguous provider evidence requires ambiguous Project terminal state'
      using errcode = '23514';
  end if;
  if v_has_input and exists (
    select 1 from public.optimizer_project_wmo_hazards as hazards
    where hazards.job_id = p_job_id and hazards.state = 'active'
  ) then
    raise exception 'Project job cannot finish with an active provider hazard'
      using errcode = '23514';
  end if;

  update public.optimizer_project_jobs
  set status = p_status,
      public_error_code = p_public_error_code,
      public_error_message = p_public_error_message,
      worker_id = null,
      claim_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status in ('claimed', 'running')
    and lease_expires_at > pg_catalog.clock_timestamp()
  returning * into v_job;
  if v_job.id is null then
    return;
  end if;

  update public.optimizer_project_credit_reservations
  set state = 'released', released_at = pg_catalog.clock_timestamp()
  where job_id = p_job_id and state = 'reserved';

  v_payload := case
    when p_status = 'completed' then
      pg_catalog.jsonb_build_object('message', 'Project work completed')
    else pg_catalog.jsonb_build_object(
      'error_code', p_public_error_code,
      'message', p_public_error_message
    )
  end;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    p_status,
    v_job.stage,
    v_payload
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create or replace function public.cancel_queued_optimizer_project_job(p_job_id pg_catalog.uuid)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  update public.optimizer_project_jobs
  set status = 'cancelled',
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id and status = 'queued'
  returning * into v_job;
  if v_job.id is null then
    return;
  end if;
  update public.optimizer_project_credit_reservations
  set state = 'released', released_at = pg_catalog.clock_timestamp()
  where job_id = p_job_id and state = 'reserved';
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'cancelled',
    v_job.stage,
    pg_catalog.jsonb_build_object('message', 'Queued Project work cancelled')
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

revoke all on function public.finish_optimizer_project_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.finish_optimizer_project_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) to service_role;
revoke all on function public.cancel_queued_optimizer_project_job(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_queued_optimizer_project_job(pg_catalog.uuid)
  to service_role;
