-- Latest-successful Project router activation and private online serving.
--
-- The active router is a single in-place pointer, not a customer-visible
-- revision history.  Provider credentials remain in Vault; this migration
-- persists only monotonic connection revisions and alias-free economics.

update storage.buckets
set allowed_mime_types = allowed_mime_types
  || array['application/zip']::pg_catalog.text[]
where id = 'explabs-artifacts'
  and allowed_mime_types is not null
  and not ('application/zip' = any(
    allowed_mime_types
  ));

create sequence public.optimizer_project_provider_revision_seq as pg_catalog.int8;

alter table public.provider_connections
  add column serving_revision pg_catalog.int8
    not null default pg_catalog.nextval('public.optimizer_project_provider_revision_seq')
    check (serving_revision > 0);

create index provider_connections_serving_revision_idx
  on public.provider_connections (id, serving_revision);

create function public.bump_optimizer_project_provider_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.serving_revision := pg_catalog.nextval(
    'public.optimizer_project_provider_revision_seq'
  );
  return new;
end;
$$;

revoke all on function public.bump_optimizer_project_provider_revision()
  from public, anon, authenticated, service_role;

create trigger provider_connections_bump_serving_revision
before update of config, vault_secret_id, credential_last4, setup_alias
on public.provider_connections
for each row execute function public.bump_optimizer_project_provider_revision();

alter table public.optimizer_project_job_inputs
  add constraint optimizer_project_job_inputs_project_scope_key
  unique (job_id, project_id);

create table public.optimizer_project_router_preflights (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  project_id pg_catalog.uuid not null,
  bundle_sha256 pg_catalog.text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  policy_id pg_catalog.text not null,
  catalog_artifact_id pg_catalog.text not null,
  catalog_manifest_sha256 pg_catalog.text not null
    check (catalog_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  setup_version pg_catalog.int8 not null check (setup_version > 0),
  setup_sha256 pg_catalog.text not null check (setup_sha256 ~ '^[0-9a-f]{64}$'),
  connection_revision_sha256 pg_catalog.text not null
    check (connection_revision_sha256 ~ '^[0-9a-f]{64}$'),
  platform_provider_revision pg_catalog.text not null check (
    pg_catalog.char_length(platform_provider_revision) between 1 and 128
    and platform_provider_revision !~ '[[:cntrl:]]'
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (job_id, project_id),
  foreign key (job_id, project_id)
    references public.optimizer_project_job_inputs(job_id, project_id)
    on delete cascade
);

create table public.optimizer_project_active_routers (
  project_id pg_catalog.uuid primary key
    references public.optimizer_projects(id) on delete cascade,
  job_id pg_catalog.uuid not null unique
    references public.optimizer_project_job_inputs(job_id) on delete restrict,
  generation pg_catalog.int8 not null check (generation > 0),
  activated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

create table public.optimizer_project_serving_settings (
  project_id pg_catalog.uuid primary key
    references public.optimizer_projects(id) on delete cascade,
  paused pg_catalog.bool not null default false,
  store_bodies pg_catalog.bool not null default true,
  monthly_spend_limit_usd pg_catalog.numeric(20, 6) check (
    monthly_spend_limit_usd is null or monthly_spend_limit_usd >= 0
  ),
  monthly_token_limit pg_catalog.int8 check (
    monthly_token_limit is null or monthly_token_limit between 0 and 9007199254740991
  ),
  spend_alert_fraction pg_catalog.numeric(8, 6) check (
    spend_alert_fraction is null
    or (spend_alert_fraction > 0 and spend_alert_fraction <= 1)
  ),
  updated_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  check (spend_alert_fraction is null or monthly_spend_limit_usd is not null)
);

alter table public.serving_requests
  add column optimizer_project_id pg_catalog.uuid
    references public.optimizer_projects(id) on delete cascade,
  add column server_interaction_id pg_catalog.uuid,
  add column active_router_job_id pg_catalog.uuid,
  add column active_router_generation pg_catalog.int8,
  add column settlement_sha256 pg_catalog.text,
  add column optimizer_project_billing_source pg_catalog.text check (
    optimizer_project_billing_source is null
    or optimizer_project_billing_source in (
      'host_managed', 'customer_managed', 'mixed', 'none'
    )
  ),
  add column optimizer_project_billing_breakdown pg_catalog.jsonb,
  add constraint serving_requests_optimizer_project_shape check (
    (
      optimizer_project_id is null
      and server_interaction_id is null
      and active_router_job_id is null
      and active_router_generation is null
      and settlement_sha256 is null
      and optimizer_project_billing_source is null
      and optimizer_project_billing_breakdown is null
    )
    or (
      optimizer_project_id is not null
      and server_interaction_id is not null
      and active_router_job_id is not null
      and active_router_generation > 0
      and settlement_sha256 ~ '^[0-9a-f]{64}$'
      and model is null
      and provider_model is null
      and cluster_id is null
      and cluster_label is null
      and routing_reason is null
      and router_cost_usd is null
      and provider_connection_id is null
      and (
        (status = 'ok' and error_message is null)
        or (
          status = 'error'
          and error_message in (
            'invalid_request', 'model_capability_invalid', 'provider_failed',
            'outcome_ambiguous', 'service_unavailable', 'internal_failure',
            'model_paused', 'credits_exhausted',
            'spend_limit_exceeded', 'token_limit_exceeded'
          )
        )
      )
      and pg_catalog.jsonb_typeof(optimizer_project_billing_breakdown) = 'object'
      and optimizer_project_billing_breakdown ?& array[
        'router_embedding', 'selected_candidate'
      ]::pg_catalog.text[]
      and optimizer_project_billing_breakdown - array[
        'router_embedding', 'selected_candidate'
      ]::pg_catalog.text[] = '{}'::pg_catalog.jsonb
      and optimizer_project_billing_breakdown ->> 'router_embedding'
        in ('host_managed', 'customer_managed', 'not_applicable')
      and optimizer_project_billing_breakdown ->> 'selected_candidate'
        in ('host_managed', 'customer_managed', 'not_applicable')
      and (
        (
          optimizer_project_billing_source = 'host_managed'
          and byok = false
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            in ('host_managed', 'not_applicable')
          and optimizer_project_billing_breakdown ->> 'selected_candidate'
            in ('host_managed', 'not_applicable')
          and (
            optimizer_project_billing_breakdown ->> 'router_embedding'
              = 'host_managed'
            or optimizer_project_billing_breakdown ->> 'selected_candidate'
              = 'host_managed'
          )
        )
        or (
          optimizer_project_billing_source = 'customer_managed'
          and byok = true
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            in ('customer_managed', 'not_applicable')
          and optimizer_project_billing_breakdown ->> 'selected_candidate'
            in ('customer_managed', 'not_applicable')
          and (
            optimizer_project_billing_breakdown ->> 'router_embedding'
              = 'customer_managed'
            or optimizer_project_billing_breakdown ->> 'selected_candidate'
              = 'customer_managed'
          )
        )
        or (
          optimizer_project_billing_source = 'mixed'
          and byok = false
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            <> optimizer_project_billing_breakdown ->> 'selected_candidate'
          and (
            optimizer_project_billing_breakdown ->> 'router_embedding'
              in ('host_managed', 'customer_managed')
            or optimizer_project_billing_breakdown ->> 'selected_candidate'
              in ('host_managed', 'customer_managed')
          )
        )
        or (
          optimizer_project_billing_source = 'none'
          and byok = false
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            = 'not_applicable'
          and optimizer_project_billing_breakdown ->> 'selected_candidate'
            = 'not_applicable'
        )
      )
    )
  );

create unique index serving_requests_project_interaction_key
  on public.serving_requests (server_interaction_id)
  where server_interaction_id is not null;

create index serving_requests_project_month_idx
  on public.serving_requests (optimizer_project_id, created_at)
  where optimizer_project_id is not null;

create table public.optimizer_project_serving_components (
  serving_request_id pg_catalog.uuid not null
    references public.serving_requests(id) on delete cascade,
  operation_id pg_catalog.text not null check (
    operation_id ~ '^routed-operation-[0-9a-f]{20}$'
  ),
  operation_ordinal pg_catalog.int2 not null check (operation_ordinal in (1, 2)),
  component pg_catalog.text not null check (
    component in ('router_embedding', 'selected_candidate')
  ),
  billing_source pg_catalog.text not null check (
    billing_source in ('host_managed', 'customer_managed', 'not_applicable')
  ),
  disposition pg_catalog.text not null check (
    disposition in (
      'observed', 'locally_priced', 'reserved_ambiguous',
      'definitely_not_incurred'
    )
  ),
  operation_count pg_catalog.int2 not null check (operation_count in (0, 1)),
  usage pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(usage) = 'object'
    and usage - array[
      'input_tokens', 'output_tokens', 'cached_input_tokens',
      'cache_write_input_tokens'
    ]::pg_catalog.text[] = '{}'::pg_catalog.jsonb
  ),
  cost_usd pg_catalog.numeric(20, 6) not null check (cost_usd >= 0),
  cost_provenance pg_catalog.text not null check (
    cost_provenance in ('observed', 'estimated')
  ),
  provider_connection_id pg_catalog.uuid,
  provider_connection_revision pg_catalog.int8,
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (serving_request_id, component),
  unique (serving_request_id, operation_ordinal),
  unique (serving_request_id, operation_id),
  check (
    (component = 'router_embedding' and operation_ordinal = 1)
    or (component = 'selected_candidate' and operation_ordinal = 2)
  ),
  check (
    (disposition = 'definitely_not_incurred' and operation_count = 0 and cost_usd = 0)
    or (disposition <> 'definitely_not_incurred' and operation_count = 1)
  ),
  check (
    (
      billing_source = 'host_managed'
      and provider_connection_id is null
      and provider_connection_revision is null
    )
    or (
      billing_source = 'customer_managed'
      and provider_connection_id is not null
      and provider_connection_revision > 0
    )
    or (
      billing_source = 'not_applicable'
      and disposition = 'definitely_not_incurred'
      and provider_connection_id is null
      and provider_connection_revision is null
    )
  )
);

create index optimizer_project_serving_components_connection_idx
  on public.optimizer_project_serving_components (
    provider_connection_id, created_at
  ) where provider_connection_id is not null;

create table public.optimizer_project_serving_interactions (
  server_interaction_id pg_catalog.uuid primary key,
  project_id pg_catalog.uuid not null
    references public.optimizer_projects(id) on delete cascade,
  org_id pg_catalog.uuid not null references public.organizations(id) on delete cascade,
  api_key_id pg_catalog.uuid references public.api_keys(id) on delete set null,
  job_id pg_catalog.uuid not null
    references public.optimizer_project_job_inputs(job_id) on delete restrict,
  generation pg_catalog.int8 not null check (generation > 0),
  connection_revision_sha256 pg_catalog.text not null
    check (connection_revision_sha256 ~ '^[0-9a-f]{64}$'),
  connection_revisions pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(connection_revisions) = 'array'
    and pg_catalog.octet_length(connection_revisions::pg_catalog.text) <= 65536
  ),
  platform_provider_revision pg_catalog.text not null check (
    pg_catalog.char_length(platform_provider_revision) between 1 and 128
    and platform_provider_revision !~ '[[:cntrl:]]'
  ),
  store_bodies pg_catalog.bool not null,
  state pg_catalog.text not null default 'admitted' check (
    state in ('admitted', 'dispatch_reserved')
  ),
  reservation_stage pg_catalog.text check (
    reservation_stage is null or reservation_stage in ('embedding', 'candidate')
  ),
  reservation_sha256 pg_catalog.text check (
    reservation_sha256 is null or reservation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  dispatch_request pg_catalog.jsonb check (
    dispatch_request is null or pg_catalog.pg_column_size(dispatch_request) <= 2097152
  ),
  dispatch_components pg_catalog.jsonb check (
    dispatch_components is null
    or (
      pg_catalog.jsonb_typeof(dispatch_components) = 'array'
      and pg_catalog.jsonb_array_length(dispatch_components) = 2
      and pg_catalog.octet_length(dispatch_components::pg_catalog.text) <= 131072
    )
  ),
  reserved_total_usd pg_catalog.numeric(20, 6) not null default 0 check (
    reserved_total_usd >= 0
  ),
  reserved_host_usd pg_catalog.numeric(20, 6) not null default 0 check (
    reserved_host_usd >= 0 and reserved_host_usd <= reserved_total_usd
  ),
  reserved_tokens pg_catalog.int8 not null default 0 check (reserved_tokens >= 0),
  dispatch_started_at pg_catalog.timestamptz,
  admitted_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at pg_catalog.timestamptz not null default (
    pg_catalog.clock_timestamp() + pg_catalog.interval '15 minutes'
  ),
  unique (server_interaction_id, project_id, job_id, generation),
  check (
    (
      state = 'admitted'
      and reservation_stage is null
      and reservation_sha256 is null
      and dispatch_components is null
      and dispatch_started_at is null
      and reserved_total_usd = 0
      and reserved_host_usd = 0
      and reserved_tokens = 0
    )
    or (
      state = 'dispatch_reserved'
      and reservation_stage is not null
      and reservation_sha256 is not null
      and dispatch_components is not null
      and dispatch_started_at is not null
    )
  )
);

create index optimizer_project_serving_interactions_expiry_idx
  on public.optimizer_project_serving_interactions (expires_at);
create index optimizer_project_serving_interactions_org_reservation_idx
  on public.optimizer_project_serving_interactions (org_id)
  where state = 'dispatch_reserved';
create index optimizer_project_serving_interactions_project_reservation_idx
  on public.optimizer_project_serving_interactions (project_id)
  where state = 'dispatch_reserved';

alter table public.optimizer_project_router_preflights enable row level security;
alter table public.optimizer_project_active_routers enable row level security;
alter table public.optimizer_project_serving_settings enable row level security;
alter table public.optimizer_project_serving_components enable row level security;
alter table public.optimizer_project_serving_interactions enable row level security;

revoke all on table public.optimizer_project_router_preflights
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_active_routers
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_serving_settings
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_serving_components
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_serving_interactions
  from public, anon, authenticated, service_role;

grant select on table public.optimizer_project_router_preflights to service_role;
grant select on table public.optimizer_project_active_routers to service_role;
grant select on table public.optimizer_project_serving_settings to service_role;
grant select on table public.optimizer_project_serving_components to service_role;
grant select on table public.optimizer_project_serving_interactions to service_role;

comment on table public.optimizer_project_active_routers is
  'Single latest-successful router pointer. It is not a revision or promotion surface.';
comment on table public.optimizer_project_serving_components is
  'Private alias-free two-component economics for one Project serving interaction.';
comment on column public.provider_connections.serving_revision is
  'Monotonic non-secret cache invalidator; never a credential value or customer field.';

create table public.optimizer_project_results (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_job_inputs(job_id) on delete cascade,
  project_id pg_catalog.uuid not null,
  report pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(report) = 'object'
    and pg_catalog.octet_length(report::pg_catalog.text) <= 131072
  ),
  build_spend pg_catalog.jsonb not null check (
    pg_catalog.jsonb_typeof(build_spend) = 'object'
    and pg_catalog.octet_length(build_spend::pg_catalog.text) <= 131072
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (job_id, project_id),
  foreign key (job_id, project_id)
    references public.optimizer_project_job_inputs(job_id, project_id) on delete cascade
);

alter table public.optimizer_project_results enable row level security;
revoke all on table public.optimizer_project_results
  from public, anon, authenticated, service_role;
grant select on table public.optimizer_project_results to service_role;
comment on table public.optimizer_project_results is
  'Allowlisted customer-safe report and source-separated build-spend projection.';

create function public.optimizer_project_serving_connection_revisions(
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
    and bindings.value ->> 'credential_source' = 'byok';

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
    and bindings.value ->> 'credential_source' = 'byok';

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

create function public.optimizer_project_serving_connection_revision_sha256(
  p_job_id pg_catalog.uuid
)
returns pg_catalog.text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        public.optimizer_project_serving_connection_revisions(p_job_id)::pg_catalog.text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;

revoke all on function public.optimizer_project_serving_connection_revision_sha256(
  pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.optimizer_project_serving_connection_revision_sha256(
  pg_catalog.uuid
) to service_role;

-- Activation must compare the exact credential/config revisions while holding
-- locks that conflict with provider-connection rotation and deletion. Request
-- admission deliberately uses the unlocked projection above so ordinary BYOK
-- traffic does not serialize on connection rows.
create function public.optimizer_project_lock_serving_connection_revisions(
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
    and bindings.value ->> 'credential_source' = 'byok';

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

create function public.record_optimizer_project_router_preflight(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_platform_provider_revision pg_catalog.text
)
returns table (connection_revision_sha256 pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input public.optimizer_project_job_inputs%rowtype;
  v_commit public.optimizer_project_wmo_stage_commits%rowtype;
  v_existing public.optimizer_project_router_preflights%rowtype;
  v_connection_sha pg_catalog.text;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform public.assert_optimizer_project_wmo_fence(
    p_job_id, p_claim_token, p_claim_generation
  );
  if p_platform_provider_revision is null
     or pg_catalog.char_length(p_platform_provider_revision) not between 1 and 128
     or p_platform_provider_revision ~ '[[:cntrl:]]' then
    raise exception 'Platform provider revision is required' using errcode = '22023';
  end if;

  select inputs.* into v_input
  from public.optimizer_project_job_inputs as inputs
  join public.optimizer_project_current_jobs as current_jobs
    on current_jobs.project_id = inputs.project_id
   and current_jobs.job_id = inputs.job_id
  join public.optimizer_projects as projects on projects.id = inputs.project_id
  where inputs.job_id = p_job_id and projects.archived_at is null;
  if v_input.job_id is null then
    raise exception 'Project job is not the current active attempt' using errcode = '23514';
  end if;

  select commits.* into v_commit
  from public.optimizer_project_wmo_stage_commits as commits
  where commits.job_id = p_job_id and commits.stage = 'completing_report';
  if v_commit.job_id is null then
    raise exception 'Project router preflight requires a committed final bundle'
      using errcode = '23514';
  end if;
  v_connection_sha :=
    public.optimizer_project_serving_connection_revision_sha256(p_job_id);

  select preflights.* into v_existing
  from public.optimizer_project_router_preflights as preflights
  where preflights.job_id = p_job_id;
  if v_existing.job_id is not null then
    if v_existing.project_id <> v_input.project_id
       or v_existing.bundle_sha256 <> v_commit.bundle_sha256
       or v_existing.policy_id <> v_commit.policy_id
       or v_existing.catalog_artifact_id <> v_commit.catalog_artifact_id
       or v_existing.catalog_manifest_sha256 <> v_commit.catalog_manifest_sha256
       or v_existing.setup_version <> v_input.setup_version
       or v_existing.setup_sha256 <> v_input.setup_sha256
       or v_existing.connection_revision_sha256 <> v_connection_sha
       or v_existing.platform_provider_revision <> p_platform_provider_revision then
      raise exception 'Project router preflight replay drifted' using errcode = '23505';
    end if;
    return query select v_connection_sha;
    return;
  end if;

  insert into public.optimizer_project_router_preflights (
    job_id, project_id, bundle_sha256, policy_id,
    catalog_artifact_id, catalog_manifest_sha256,
    setup_version, setup_sha256, connection_revision_sha256,
    platform_provider_revision
  ) values (
    p_job_id, v_input.project_id, v_commit.bundle_sha256, v_commit.policy_id,
    v_commit.catalog_artifact_id, v_commit.catalog_manifest_sha256,
    v_input.setup_version, v_input.setup_sha256, v_connection_sha,
    p_platform_provider_revision
  );
  return query select v_connection_sha;
end;
$$;

revoke all on function public.record_optimizer_project_router_preflight(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.record_optimizer_project_router_preflight(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text
) to service_role;

-- Completion and latest-successful activation are one transaction.  A failed
-- or ambiguous newer attempt never changes the prior active pointer.
create or replace function public.finish_optimizer_project_job(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_status pg_catalog.text,
  p_public_error_code pg_catalog.text,
  p_public_error_message pg_catalog.text,
  p_platform_provider_revision pg_catalog.text default null
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
  v_input public.optimizer_project_job_inputs%rowtype;
  v_commit public.optimizer_project_wmo_stage_commits%rowtype;
  v_preflight public.optimizer_project_router_preflights%rowtype;
  v_project public.optimizer_projects%rowtype;
  v_payload pg_catalog.jsonb;
  v_connection_sha pg_catalog.text;
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

  select jobs.* into v_job
  from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status in ('claimed', 'running')
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if v_job.id is null then
    return;
  end if;

  select exists (
    select 1 from public.optimizer_project_job_inputs as inputs
    where inputs.job_id = p_job_id
  ) into v_has_input;

  if v_has_input and p_status = 'completed' then
    select inputs.* into v_input
    from public.optimizer_project_job_inputs as inputs
    where inputs.job_id = p_job_id;
    select projects.* into v_project
    from public.optimizer_projects as projects
    where projects.id = v_input.project_id
    for update;
    if v_project.id is null or v_project.archived_at is not null then
      raise exception 'completed Project router requires an active Project'
        using errcode = '23514';
    end if;

    perform 1
    from public.optimizer_project_current_jobs as current_jobs
    where current_jobs.project_id = v_input.project_id
      and current_jobs.job_id = p_job_id
    for update;
    if not found then
      raise exception 'only the current Project job may activate a router'
        using errcode = '23514';
    end if;

    select commits.* into v_commit
    from public.optimizer_project_wmo_stage_commits as commits
    where commits.job_id = p_job_id and commits.stage = 'completing_report';
    if v_commit.job_id is null then
      raise exception 'completed Project job requires a committed WMO report stage'
        using errcode = '23514';
    end if;

    perform 1
    from public.optimizer_project_stage_pointers as pointers
    where pointers.project_id = v_input.project_id
      and pointers.job_id = p_job_id
      and pointers.stage = 'wmo_workflow'
      and pointers.sha256 = v_commit.bundle_sha256;
    if not found then
      raise exception 'completed Project job requires its exact final stage pointer'
        using errcode = '23514';
    end if;

    select preflights.* into v_preflight
    from public.optimizer_project_router_preflights as preflights
    where preflights.job_id = p_job_id;
    if v_preflight.job_id is null
       or v_preflight.project_id <> v_input.project_id
       or v_preflight.bundle_sha256 <> v_commit.bundle_sha256
       or v_preflight.policy_id <> v_commit.policy_id
       or v_preflight.catalog_artifact_id <> v_commit.catalog_artifact_id
       or v_preflight.catalog_manifest_sha256 <> v_commit.catalog_manifest_sha256
       or v_preflight.setup_version <> v_input.setup_version
       or v_preflight.setup_sha256 <> v_input.setup_sha256 then
      raise exception 'completed Project router lacks exact activation preflight evidence'
        using errcode = '23514';
    end if;

    v_connection_sha :=
      public.optimizer_project_serving_connection_revision_sha256(p_job_id);
    if v_connection_sha <> v_preflight.connection_revision_sha256 then
      raise exception 'Project serving connection changed after activation preflight'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.list_legacy_serving_endpoints(v_input.org_id) as legacy
      where legacy.endpoint_name = v_project.slug
    ) then
      raise exception 'Project model name collides with eligible legacy serving'
        using errcode = '23505';
    end if;

    insert into public.optimizer_project_serving_settings(project_id)
    values (v_input.project_id)
    on conflict on constraint optimizer_project_serving_settings_pkey do nothing;

    insert into public.optimizer_project_active_routers (
      project_id, job_id, generation, activated_at
    ) values (
      v_input.project_id, p_job_id, 1, pg_catalog.clock_timestamp()
    )
    on conflict on constraint optimizer_project_active_routers_pkey do update
    set job_id = excluded.job_id,
        generation = public.optimizer_project_active_routers.generation + 1,
        activated_at = excluded.activated_at;
  elsif v_has_input and p_status = 'ambiguous' and not exists (
    select 1
    from public.optimizer_project_wmo_hazards as hazards
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
  returning * into v_job;

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
    v_job.id, p_status, v_job.stage, v_payload
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create function public.record_optimizer_project_router_preflight(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_platform_provider_revision pg_catalog.text,
  p_loaded_connection_revisions pg_catalog.jsonb,
  p_report pg_catalog.jsonb,
  p_build_spend pg_catalog.jsonb
)
returns table (connection_revision_sha256 pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input public.optimizer_project_job_inputs%rowtype;
  v_commit public.optimizer_project_wmo_stage_commits%rowtype;
  v_existing public.optimizer_project_router_preflights%rowtype;
  v_existing_result public.optimizer_project_results%rowtype;
  v_live_revisions pg_catalog.jsonb;
  v_connection_sha pg_catalog.text;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform public.assert_optimizer_project_wmo_fence(
    p_job_id, p_claim_token, p_claim_generation
  );
  if p_platform_provider_revision is null
     or pg_catalog.char_length(p_platform_provider_revision) not between 1 and 128
     or p_platform_provider_revision ~ '[[:cntrl:]]'
     or p_loaded_connection_revisions is null
     or pg_catalog.jsonb_typeof(p_loaded_connection_revisions) <> 'array'
     or p_report is null or pg_catalog.jsonb_typeof(p_report) <> 'object'
     or p_report - array[
       'held_out_task_count', 'routed', 'baseline', 'paired_quality',
       'fallback_count', 'fallback_rate', 'coverage'
     ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     or not p_report ?& array[
       'held_out_task_count', 'routed', 'baseline', 'paired_quality',
       'fallback_count', 'fallback_rate', 'coverage'
     ]::pg_catalog.text[]
     or p_build_spend is null or pg_catalog.jsonb_typeof(p_build_spend) <> 'object'
     or p_build_spend - array[
       'ceiling_usd', 'total_usd', 'host_managed_usd',
       'customer_managed_usd', 'outcome', 'restart', 'components'
     ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     or not p_build_spend ?& array[
       'ceiling_usd', 'total_usd', 'host_managed_usd',
       'customer_managed_usd', 'outcome', 'restart', 'components'
     ]::pg_catalog.text[]
     or pg_catalog.octet_length(p_report::pg_catalog.text) > 131072
     or pg_catalog.octet_length(p_build_spend::pg_catalog.text) > 131072 then
    raise exception 'invalid Project router activation projection' using errcode = '22023';
  end if;
  select inputs.* into v_input
  from public.optimizer_project_job_inputs as inputs
  join public.optimizer_project_current_jobs as current_jobs
    on current_jobs.project_id = inputs.project_id
   and current_jobs.job_id = inputs.job_id
  join public.optimizer_projects as projects on projects.id = inputs.project_id
  where inputs.job_id = p_job_id and projects.archived_at is null;
  if v_input.job_id is null then
    raise exception 'Project job is not the current active attempt' using errcode = '23514';
  end if;
  select commits.* into v_commit
  from public.optimizer_project_wmo_stage_commits as commits
  where commits.job_id = p_job_id and commits.stage = 'completing_report';
  if v_commit.job_id is null then
    raise exception 'Project router preflight requires a committed final bundle'
      using errcode = '23514';
  end if;
  v_live_revisions :=
    public.optimizer_project_lock_serving_connection_revisions(p_job_id);
  if v_live_revisions <> p_loaded_connection_revisions then
    raise exception 'Project serving connection changed during activation preflight'
      using errcode = '40001';
  end if;
  v_connection_sha := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_live_revisions::pg_catalog.text, 'UTF8')),
    'hex'
  );
  select preflights.* into v_existing
  from public.optimizer_project_router_preflights as preflights
  where preflights.job_id = p_job_id;
  select results.* into v_existing_result
  from public.optimizer_project_results as results
  where results.job_id = p_job_id;
  if v_existing.job_id is not null then
    if v_existing.project_id <> v_input.project_id
       or v_existing.bundle_sha256 <> v_commit.bundle_sha256
       or v_existing.policy_id <> v_commit.policy_id
       or v_existing.catalog_artifact_id <> v_commit.catalog_artifact_id
       or v_existing.catalog_manifest_sha256 <> v_commit.catalog_manifest_sha256
       or v_existing.setup_version <> v_input.setup_version
       or v_existing.setup_sha256 <> v_input.setup_sha256
       or v_existing.connection_revision_sha256 <> v_connection_sha
       or v_existing.platform_provider_revision <> p_platform_provider_revision
       or v_existing_result.job_id is null
       or v_existing_result.project_id <> v_input.project_id
       or v_existing_result.report <> p_report
       or v_existing_result.build_spend <> p_build_spend then
      raise exception 'Project router preflight replay drifted' using errcode = '23505';
    end if;
    return query select v_connection_sha;
    return;
  end if;
  insert into public.optimizer_project_router_preflights (
    job_id, project_id, bundle_sha256, policy_id,
    catalog_artifact_id, catalog_manifest_sha256,
    setup_version, setup_sha256, connection_revision_sha256,
    platform_provider_revision
  ) values (
    p_job_id, v_input.project_id, v_commit.bundle_sha256, v_commit.policy_id,
    v_commit.catalog_artifact_id, v_commit.catalog_manifest_sha256,
    v_input.setup_version, v_input.setup_sha256, v_connection_sha,
    p_platform_provider_revision
  );
  insert into public.optimizer_project_results(job_id, project_id, report, build_spend)
  values (p_job_id, v_input.project_id, p_report, p_build_spend);
  return query select v_connection_sha;
end;
$$;

revoke all on function public.record_optimizer_project_router_preflight(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.record_optimizer_project_router_preflight(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.jsonb, pg_catalog.jsonb, pg_catalog.jsonb
) to service_role;

drop function public.record_optimizer_project_router_preflight(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text
);

create function public.list_optimizer_project_serving_models(
  p_org_id pg_catalog.uuid
)
returns table (
  project_id pg_catalog.uuid,
  slug pg_catalog.text,
  created_at pg_catalog.timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select projects.id, projects.slug, projects.created_at
  from public.optimizer_projects as projects
  join public.optimizer_project_active_routers as active
    on active.project_id = projects.id
  join public.optimizer_project_jobs as jobs
    on jobs.id = active.job_id and jobs.status = 'completed'
  where projects.org_id = p_org_id and projects.archived_at is null
  order by projects.created_at desc, projects.slug;
$$;

revoke all on function public.list_optimizer_project_serving_models(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.list_optimizer_project_serving_models(pg_catalog.uuid)
  to service_role;

create function public.resolve_optimizer_project_serving_model(
  p_org_id pg_catalog.uuid,
  p_slug pg_catalog.text
)
returns table (
  project_id pg_catalog.uuid,
  slug pg_catalog.text,
  created_at pg_catalog.timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select models.*
  from public.list_optimizer_project_serving_models(p_org_id) as models
  where models.slug = p_slug
  limit 1;
$$;

revoke all on function public.resolve_optimizer_project_serving_model(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.resolve_optimizer_project_serving_model(
  pg_catalog.uuid, pg_catalog.text
) to service_role;

create function public.count_completed_optimizer_project_jobs_without_active_router()
returns pg_catalog.int8
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.count(*)
  from public.optimizer_project_jobs as jobs
  join public.optimizer_project_job_inputs as inputs on inputs.job_id = jobs.id
  where jobs.status = 'completed'
    and not exists (
      select 1 from public.optimizer_project_active_routers as active
      where active.job_id = jobs.id
    );
$$;

revoke all on function public.count_completed_optimizer_project_jobs_without_active_router()
  from public, anon, authenticated;
grant execute on function public.count_completed_optimizer_project_jobs_without_active_router()
  to service_role;

create function public.get_optimizer_project_serving_settings(
  p_project_id pg_catalog.uuid
)
returns table (
  project_id pg_catalog.uuid,
  paused pg_catalog.bool,
  store_bodies pg_catalog.bool,
  monthly_spend_limit_usd pg_catalog.text,
  monthly_token_limit pg_catalog.int8,
  spend_alert_fraction pg_catalog.text,
  updated_at pg_catalog.timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  insert into public.optimizer_project_serving_settings(project_id)
  select projects.id from public.optimizer_projects as projects
  where projects.id = p_project_id
  on conflict on constraint optimizer_project_serving_settings_pkey do nothing;
  return query
  select settings.project_id, settings.paused, settings.store_bodies,
         settings.monthly_spend_limit_usd::pg_catalog.text,
         settings.monthly_token_limit,
         settings.spend_alert_fraction::pg_catalog.text,
         settings.updated_at
  from public.optimizer_project_serving_settings as settings
  where settings.project_id = p_project_id;
end;
$$;

create function public.update_optimizer_project_serving_settings(
  p_project_id pg_catalog.uuid,
  p_paused pg_catalog.bool,
  p_store_bodies pg_catalog.bool,
  p_monthly_spend_limit_usd pg_catalog.numeric,
  p_monthly_token_limit pg_catalog.int8,
  p_spend_alert_fraction pg_catalog.numeric,
  p_expected_updated_at pg_catalog.timestamptz
)
returns table (
  project_id pg_catalog.uuid,
  paused pg_catalog.bool,
  store_bodies pg_catalog.bool,
  monthly_spend_limit_usd pg_catalog.text,
  monthly_token_limit pg_catalog.int8,
  spend_alert_fraction pg_catalog.text,
  updated_at pg_catalog.timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.optimizer_project_serving_settings%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_paused is null or p_store_bodies is null
     or p_monthly_spend_limit_usd < 0
     or p_monthly_token_limit < 0
     or p_monthly_token_limit > 9007199254740991
     or p_spend_alert_fraction <= 0
     or p_spend_alert_fraction > 1
     or (p_spend_alert_fraction is not null and p_monthly_spend_limit_usd is null) then
    raise exception 'invalid Project serving settings' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.optimizer_projects as projects
    where projects.id = p_project_id
  ) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  select settings.* into v_existing
  from public.optimizer_project_serving_settings as settings
  where settings.project_id = p_project_id
  for update;
  if v_existing.project_id is not null
     and v_existing.updated_at is distinct from p_expected_updated_at then
    if v_existing.paused = p_paused
       and v_existing.store_bodies = p_store_bodies
       and v_existing.monthly_spend_limit_usd
         is not distinct from p_monthly_spend_limit_usd
       and v_existing.monthly_token_limit is not distinct from p_monthly_token_limit
       and v_existing.spend_alert_fraction is not distinct from p_spend_alert_fraction then
      return query select *
      from public.get_optimizer_project_serving_settings(p_project_id);
      return;
    end if;
    raise exception 'Project serving settings changed concurrently'
      using errcode = '40001';
  end if;
  if v_existing.project_id is null and p_expected_updated_at is not null then
    raise exception 'Project serving settings changed concurrently'
      using errcode = '40001';
  end if;
  insert into public.optimizer_project_serving_settings (
    project_id, paused, store_bodies, monthly_spend_limit_usd,
    monthly_token_limit, spend_alert_fraction, updated_at
  ) values (
    p_project_id, p_paused, p_store_bodies, p_monthly_spend_limit_usd,
    p_monthly_token_limit, p_spend_alert_fraction, pg_catalog.clock_timestamp()
  )
  on conflict on constraint optimizer_project_serving_settings_pkey do update
  set paused = excluded.paused,
      store_bodies = excluded.store_bodies,
      monthly_spend_limit_usd = excluded.monthly_spend_limit_usd,
      monthly_token_limit = excluded.monthly_token_limit,
      spend_alert_fraction = excluded.spend_alert_fraction,
      updated_at = excluded.updated_at;
  return query select * from public.get_optimizer_project_serving_settings(p_project_id);
end;
$$;

revoke all on function public.get_optimizer_project_serving_settings(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_serving_settings(pg_catalog.uuid)
  to service_role;
revoke all on function public.update_optimizer_project_serving_settings(
  pg_catalog.uuid, pg_catalog.bool, pg_catalog.bool, pg_catalog.numeric,
  pg_catalog.int8, pg_catalog.numeric, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.update_optimizer_project_serving_settings(
  pg_catalog.uuid, pg_catalog.bool, pg_catalog.bool, pg_catalog.numeric,
  pg_catalog.int8, pg_catalog.numeric, pg_catalog.timestamptz
) to service_role;

create function public.reconcile_optimizer_project_serving_interactions(
  p_limit pg_catalog.int4 default 100
)
returns pg_catalog.int4
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return 0;
end;
$$;

revoke all on function public.reconcile_optimizer_project_serving_interactions(
  pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.reconcile_optimizer_project_serving_interactions(
  pg_catalog.int4
) to service_role;

create function public.admit_optimizer_project_serving_interaction(
  p_org_id pg_catalog.uuid,
  p_slug pg_catalog.text,
  p_server_interaction_id pg_catalog.uuid,
  p_platform_provider_revision pg_catalog.text,
  p_api_key_id pg_catalog.uuid default null
)
returns table (
  project_id pg_catalog.uuid,
  org_id pg_catalog.uuid,
  slug pg_catalog.text,
  wmo_project_id pg_catalog.text,
  job_id pg_catalog.uuid,
  generation pg_catalog.int8,
  bundle_storage_bucket pg_catalog.text,
  bundle_storage_path pg_catalog.text,
  bundle_sha256 pg_catalog.text,
  bundle_size_bytes pg_catalog.int8,
  policy_id pg_catalog.text,
  report_id pg_catalog.text,
  catalog_artifact_id pg_catalog.text,
  catalog_manifest_sha256 pg_catalog.text,
  setup_version pg_catalog.int8,
  setup_sha256 pg_catalog.text,
  setup_snapshot pg_catalog.jsonb,
  connection_revision_sha256 pg_catalog.text,
  connection_revisions pg_catalog.jsonb,
  store_bodies pg_catalog.bool
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.optimizer_projects%rowtype;
  v_active public.optimizer_project_active_routers%rowtype;
  v_input public.optimizer_project_job_inputs%rowtype;
  v_commit public.optimizer_project_wmo_stage_commits%rowtype;
  v_settings public.optimizer_project_serving_settings%rowtype;
  v_connections pg_catalog.jsonb;
  v_connection_sha pg_catalog.text;
  v_month_start pg_catalog.timestamptz;
  v_month_spend pg_catalog.numeric;
  v_month_tokens pg_catalog.int8;
  v_has_host_managed pg_catalog.bool;
  v_available_credit pg_catalog.numeric;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform public.reconcile_optimizer_project_serving_interactions(100);
  if p_server_interaction_id is null
     or p_platform_provider_revision is null
     or pg_catalog.char_length(p_platform_provider_revision) not between 1 and 128
     or p_platform_provider_revision ~ '[[:cntrl:]]' then
    raise exception 'invalid Project serving interaction identity' using errcode = '22023';
  end if;
  if p_api_key_id is not null and not exists (
    select 1
    from public.api_keys as api_keys
    where api_keys.id = p_api_key_id
      and api_keys.org_id = p_org_id
      and api_keys.revoked_at is null
  ) then
    raise exception 'Project serving API key attribution is invalid'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.optimizer_project_serving_interactions as interactions
    where interactions.server_interaction_id = p_server_interaction_id
  ) or exists (
    select 1 from public.serving_requests as requests
    where requests.server_interaction_id = p_server_interaction_id
  ) then
    raise exception 'Project serving interaction was already admitted'
      using errcode = '23505';
  end if;

  select projects.* into v_project
  from public.optimizer_projects as projects
  where projects.org_id = p_org_id
    and projects.slug = p_slug
    and projects.archived_at is null;
  if v_project.id is null then
    raise exception 'Project model not found' using errcode = 'P0002';
  end if;
  select active.* into v_active
  from public.optimizer_project_active_routers as active
  join public.optimizer_project_jobs as jobs
    on jobs.id = active.job_id and jobs.status = 'completed'
  where active.project_id = v_project.id;
  if v_active.project_id is null then
    raise exception 'Project model not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.list_legacy_serving_endpoints(p_org_id) as legacy
    where legacy.endpoint_name = p_slug
  ) then
    raise exception 'Project model name collides with eligible legacy serving'
      using errcode = '23505';
  end if;

  select inputs.* into v_input
  from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = v_active.job_id and inputs.project_id = v_project.id;
  select commits.* into v_commit
  from public.optimizer_project_wmo_stage_commits as commits
  where commits.job_id = v_active.job_id and commits.stage = 'completing_report';
  if v_input.job_id is null or v_commit.job_id is null then
    raise exception 'Project serving activation is incomplete' using errcode = '23514';
  end if;

  insert into public.optimizer_project_serving_settings(project_id)
  values (v_project.id)
  on conflict on constraint optimizer_project_serving_settings_pkey do nothing;
  select settings.* into v_settings
  from public.optimizer_project_serving_settings as settings
  where settings.project_id = v_project.id;
  if v_settings.paused then
    raise exception 'Project model is paused' using errcode = 'P0001';
  end if;

  v_month_start := (
    pg_catalog.date_trunc(
      'month', pg_catalog.statement_timestamp() at time zone 'UTC'
    ) at time zone 'UTC'
  );
  select coalesce(pg_catalog.sum(requests.cost_usd), 0),
         coalesce(pg_catalog.sum(requests.input_tokens + requests.output_tokens), 0)
    into v_month_spend, v_month_tokens
  from public.serving_requests as requests
  where requests.optimizer_project_id = v_project.id
    and requests.created_at >= v_month_start;
  if v_settings.monthly_spend_limit_usd is not null
     and v_month_spend >= v_settings.monthly_spend_limit_usd then
    raise exception 'Project monthly spend limit is exhausted' using errcode = 'P0001';
  end if;
  if v_settings.monthly_token_limit is not null
     and v_month_tokens >= v_settings.monthly_token_limit then
    raise exception 'Project monthly token limit is exhausted' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_input.setup_snapshot -> 'models') as bindings(value)
    where bindings.value ->> 'role' in ('embedder', 'baseline', 'candidate')
      and bindings.value ->> 'credential_source' = 'platform'
  ) into v_has_host_managed;
  select organizations.credit_granted_usd - organizations.billable_spend_usd
    into v_available_credit
  from public.organizations as organizations
  where organizations.id = p_org_id;
  if v_has_host_managed and coalesce(v_available_credit, 0) <= 0 then
    raise exception 'Project Platform credit is exhausted' using errcode = 'P0001';
  end if;

  v_connections := public.optimizer_project_serving_connection_revisions(v_active.job_id);
  v_connection_sha := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_connections::pg_catalog.text, 'UTF8')
    ),
    'hex'
  );
  insert into public.optimizer_project_serving_interactions (
    server_interaction_id, project_id, org_id, api_key_id, job_id, generation,
    connection_revision_sha256, connection_revisions,
    platform_provider_revision, store_bodies
  ) values (
    p_server_interaction_id, v_project.id, p_org_id, p_api_key_id, v_active.job_id,
    v_active.generation, v_connection_sha, v_connections,
    p_platform_provider_revision, v_settings.store_bodies
  );

  return query select
    v_project.id, p_org_id, v_project.slug, v_input.wmo_project_id,
    v_active.job_id, v_active.generation,
    v_commit.bundle_storage_bucket, v_commit.bundle_storage_path,
    v_commit.bundle_sha256, v_commit.bundle_size_bytes,
    v_commit.policy_id, v_commit.report_id,
    v_commit.catalog_artifact_id, v_commit.catalog_manifest_sha256,
    v_input.setup_version, v_input.setup_sha256, v_input.setup_snapshot,
    v_connection_sha, v_connections, v_settings.store_bodies;
end;
$$;

revoke all on function public.admit_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.admit_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid
) to service_role;

create function public.release_optimizer_project_serving_credential(
  p_server_interaction_id pg_catalog.uuid,
  p_internal_alias pg_catalog.text,
  p_provider_connection_id pg_catalog.uuid,
  p_serving_revision pg_catalog.int8
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
  v_interaction public.optimizer_project_serving_interactions%rowtype;
  v_provider pg_catalog.text;
  v_alias pg_catalog.text;
  v_vault_secret_id pg_catalog.uuid;
begin
  perform public.optimizer_project_wmo_require_service_role();
  select interactions.* into v_interaction
  from public.optimizer_project_serving_interactions as interactions
  where interactions.server_interaction_id = p_server_interaction_id
    and interactions.expires_at > pg_catalog.clock_timestamp()
    and interactions.state = 'admitted';
  if v_interaction.server_interaction_id is null then
    raise exception 'Project serving interaction admission is unavailable'
      using errcode = 'P0002';
  end if;
  select bindings.value ->> 'provider', bindings.value ->> 'connection_alias'
    into v_provider, v_alias
  from public.optimizer_project_job_inputs as inputs
  cross join pg_catalog.jsonb_array_elements(
    inputs.setup_snapshot -> 'models'
  ) as bindings(value)
  where inputs.job_id = v_interaction.job_id
    and bindings.value ->> 'internal_alias' = p_internal_alias
    and bindings.value ->> 'role' in ('embedder', 'baseline', 'candidate')
    and bindings.value ->> 'credential_source' = 'byok';
  if v_provider is null or not exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_interaction.connection_revisions) as revisions(value)
    where revisions.value ->> 'internal_alias' = p_internal_alias
      and (revisions.value ->> 'provider_connection_id')::pg_catalog.uuid
        = p_provider_connection_id
      and (revisions.value ->> 'serving_revision')::pg_catalog.int8
        = p_serving_revision
  ) then
    raise exception 'Project serving connection is outside its admission'
      using errcode = '42501';
  end if;

  select connections.vault_secret_id into v_vault_secret_id
  from public.provider_connections as connections
  where connections.id = p_provider_connection_id
    and connections.org_id = v_interaction.org_id
    and connections.provider = v_provider
    and connections.setup_alias = v_alias
    and connections.serving_revision = p_serving_revision
  for update;
  if v_vault_secret_id is null then
    raise exception 'Project serving provider connection changed'
      using errcode = 'P0002';
  end if;
  update public.provider_connections
  set last_used_at = pg_catalog.clock_timestamp()
  where id = p_provider_connection_id;
  return query
  select connections.provider, connections.setup_alias, connections.config,
         decrypted.decrypted_secret
  from public.provider_connections as connections
  join vault.decrypted_secrets as decrypted
    on decrypted.id = connections.vault_secret_id
  where connections.id = p_provider_connection_id
    and decrypted.decrypted_secret is not null;
  if not found then
    raise exception 'Project serving credential is unavailable' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.release_optimizer_project_serving_credential(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.release_optimizer_project_serving_credential(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.int8
) to service_role;

create function public.reserve_optimizer_project_serving_dispatch(
  p_server_interaction_id pg_catalog.uuid,
  p_stage pg_catalog.text,
  p_request pg_catalog.jsonb,
  p_components pg_catalog.jsonb
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interaction public.optimizer_project_serving_interactions%rowtype;
  v_sha pg_catalog.text;
  v_existing_rank pg_catalog.int2;
  v_requested_rank pg_catalog.int2;
  v_settings public.optimizer_project_serving_settings%rowtype;
  v_new_total pg_catalog.numeric(20, 6);
  v_new_host pg_catalog.numeric(20, 6);
  v_new_tokens pg_catalog.int8;
  v_other_host pg_catalog.numeric(20, 6);
  v_other_project_total pg_catalog.numeric(20, 6);
  v_other_project_tokens pg_catalog.int8;
  v_month_total pg_catalog.numeric(20, 6);
  v_month_tokens pg_catalog.int8;
  v_credit_granted pg_catalog.numeric(20, 6);
  v_billable_spend pg_catalog.numeric(20, 6);
  v_month_start pg_catalog.timestamptz;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_stage not in ('embedding', 'candidate')
     or p_request is not null and pg_catalog.jsonb_typeof(p_request) <> 'object'
     or p_request is not null and pg_catalog.pg_column_size(p_request) > 2097152
     or p_components is null
     or pg_catalog.jsonb_typeof(p_components) <> 'array'
     or pg_catalog.jsonb_array_length(p_components) <> 2
     or pg_catalog.octet_length(p_components::pg_catalog.text) > 131072 then
    raise exception 'invalid Project serving dispatch reservation'
      using errcode = '22023';
  end if;
  v_sha := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'stage', p_stage,
          'request', p_request,
          'components', p_components
        )::pg_catalog.text,
        'UTF8'
      )
    ),
    'hex'
  );
  select interactions.* into v_interaction
  from public.optimizer_project_serving_interactions as interactions
  where interactions.server_interaction_id = p_server_interaction_id
  for update;
  if v_interaction.server_interaction_id is null then
    if exists (
      select 1 from public.serving_requests as requests
      where requests.server_interaction_id = p_server_interaction_id
    ) then
      return true;
    end if;
    raise exception 'Project serving interaction was not admitted'
      using errcode = 'P0002';
  end if;
  v_existing_rank := case v_interaction.reservation_stage
    when 'embedding' then 1 when 'candidate' then 2 else 0 end;
  v_requested_rank := case p_stage when 'embedding' then 1 else 2 end;
  if v_existing_rank > v_requested_rank then
    raise exception 'Project serving reservation cannot move backward'
      using errcode = '23505';
  end if;
  if v_existing_rank = v_requested_rank then
    if v_interaction.reservation_sha256 <> v_sha then
      raise exception 'Project serving reservation replay drifted'
        using errcode = '23505';
    end if;
    return true;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where pg_catalog.jsonb_typeof(components.value) <> 'object'
      or components.value ->> 'component' not in (
        'router_embedding', 'selected_candidate'
      )
      or components.value ->> 'billing_source' not in (
        'host_managed', 'customer_managed', 'not_applicable'
      )
      or (components.value ->> 'cost_usd')::pg_catalog.numeric < 0
      or (components.value ->> 'cost_usd')::pg_catalog.numeric
        <> pg_catalog.round(
          (components.value ->> 'cost_usd')::pg_catalog.numeric,
          6
        )
      or pg_catalog.jsonb_typeof(components.value -> 'usage') <> 'object'
      or (components.value -> 'usage' ->> 'input_tokens')::pg_catalog.int8 < 0
      or (components.value -> 'usage' ->> 'output_tokens')::pg_catalog.int8 < 0
      or (
        components.value ->> 'billing_source' = 'not_applicable'
        and (
          components.value ->> 'disposition' <> 'definitely_not_incurred'
          or (components.value ->> 'operation_count')::pg_catalog.int2 <> 0
          or (components.value ->> 'cost_usd')::pg_catalog.numeric <> 0
        )
      )
  ) then
    raise exception 'invalid Project serving dispatch economics'
      using errcode = '22023';
  end if;
  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'component' = 'router_embedding'
      and (components.value ->> 'operation_ordinal')::pg_catalog.int2 = 1
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'component' = 'selected_candidate'
      and (components.value ->> 'operation_ordinal')::pg_catalog.int2 = 2
  ) <> 1 then
    raise exception 'Project serving reservation requires exactly two components'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where (
      components.value ->> 'billing_source' in ('host_managed', 'not_applicable')
      and (
        nullif(components.value ->> 'provider_connection_id', '') is not null
        or nullif(components.value ->> 'provider_connection_revision', '') is not null
      )
    ) or (
      components.value ->> 'billing_source' = 'customer_managed'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          v_interaction.connection_revisions
        ) as revisions(value)
        where revisions.value ->> 'provider_connection_id'
            = components.value ->> 'provider_connection_id'
          and revisions.value ->> 'serving_revision'
            = components.value ->> 'provider_connection_revision'
      )
    )
  ) then
    raise exception 'Project serving reservation payer evidence is invalid'
      using errcode = '42501';
  end if;
  select
    coalesce(pg_catalog.sum(
      (components.value ->> 'cost_usd')::pg_catalog.numeric
    ), 0),
    coalesce(pg_catalog.sum(
      (components.value ->> 'cost_usd')::pg_catalog.numeric
    ) filter (where components.value ->> 'billing_source' = 'host_managed'), 0),
    coalesce(pg_catalog.sum(
      (components.value -> 'usage' ->> 'input_tokens')::pg_catalog.int8
        + (components.value -> 'usage' ->> 'output_tokens')::pg_catalog.int8
    ) filter (where components.value ->> 'component' = 'selected_candidate'), 0)
    into v_new_total, v_new_host, v_new_tokens
  from pg_catalog.jsonb_array_elements(p_components) as components(value);

  select settings.* into v_settings
  from public.optimizer_project_serving_settings as settings
  where settings.project_id = v_interaction.project_id
  for update;
  if v_settings.project_id is null or v_settings.paused then
    raise exception 'Project serving dispatch is blocked'
      using errcode = 'P1001', detail = 'model_paused';
  end if;
  select organizations.credit_granted_usd, organizations.billable_spend_usd
    into v_credit_granted, v_billable_spend
  from public.organizations as organizations
  where organizations.id = v_interaction.org_id
  for update;
  if not found then
    raise exception 'Project serving organization is unavailable'
      using errcode = 'P0002';
  end if;
  select
    coalesce(pg_catalog.sum(interactions.reserved_host_usd), 0),
    coalesce(pg_catalog.sum(interactions.reserved_total_usd) filter (
      where interactions.project_id = v_interaction.project_id
    ), 0),
    coalesce(pg_catalog.sum(interactions.reserved_tokens) filter (
      where interactions.project_id = v_interaction.project_id
    ), 0)
    into v_other_host, v_other_project_total, v_other_project_tokens
  from public.optimizer_project_serving_interactions as interactions
  where interactions.org_id = v_interaction.org_id
    and interactions.server_interaction_id <> p_server_interaction_id
    and interactions.state = 'dispatch_reserved';
  if v_new_host > v_credit_granted - v_billable_spend - v_other_host then
    raise exception 'Project serving dispatch is blocked'
      using errcode = 'P1002', detail = 'credits_exhausted';
  end if;
  v_month_start := (
    pg_catalog.date_trunc(
      'month', pg_catalog.statement_timestamp() at time zone 'UTC'
    ) at time zone 'UTC'
  );
  select coalesce(pg_catalog.sum(requests.cost_usd), 0),
         coalesce(pg_catalog.sum(requests.input_tokens + requests.output_tokens), 0)
    into v_month_total, v_month_tokens
  from public.serving_requests as requests
  where requests.optimizer_project_id = v_interaction.project_id
    and requests.created_at >= v_month_start;
  if v_settings.monthly_spend_limit_usd is not null
     and v_month_total + v_other_project_total + v_new_total
       > v_settings.monthly_spend_limit_usd then
    raise exception 'Project serving dispatch is blocked'
      using errcode = 'P1003', detail = 'spend_limit_exceeded';
  end if;
  if v_settings.monthly_token_limit is not null
     and v_month_tokens + v_other_project_tokens + v_new_tokens
       > v_settings.monthly_token_limit then
    raise exception 'Project serving dispatch is blocked'
      using errcode = 'P1004', detail = 'token_limit_exceeded';
  end if;
  update public.optimizer_project_serving_interactions as interactions
  set state = 'dispatch_reserved',
      reservation_stage = p_stage,
      reservation_sha256 = v_sha,
      dispatch_request = p_request,
      dispatch_components = p_components,
      reserved_total_usd = v_new_total,
      reserved_host_usd = v_new_host,
      reserved_tokens = v_new_tokens,
      dispatch_started_at = pg_catalog.clock_timestamp(),
      expires_at = pg_catalog.clock_timestamp() + pg_catalog.interval '15 minutes'
  where interactions.server_interaction_id = p_server_interaction_id;
  return true;
end;
$$;

revoke all on function public.reserve_optimizer_project_serving_dispatch(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.reserve_optimizer_project_serving_dispatch(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb, pg_catalog.jsonb
) to service_role;

create function public.abandon_optimizer_project_serving_interaction(
  p_server_interaction_id pg_catalog.uuid,
  p_preserve_terminal pg_catalog.bool default false
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed pg_catalog.int8;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_preserve_terminal then
    update public.optimizer_project_serving_interactions as interactions
    set expires_at = least(interactions.expires_at, pg_catalog.clock_timestamp())
    where interactions.server_interaction_id = p_server_interaction_id
      and interactions.state = 'dispatch_reserved';
  else
    delete from public.optimizer_project_serving_interactions as interactions
    where interactions.server_interaction_id = p_server_interaction_id
      and interactions.state = 'admitted';
  end if;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

revoke all on function public.abandon_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.bool
) from public, anon, authenticated;
grant execute on function public.abandon_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.bool
) to service_role;

create function public.settle_optimizer_project_serving_interaction(
  p_server_interaction_id pg_catalog.uuid,
  p_request pg_catalog.jsonb,
  p_response pg_catalog.jsonb,
  p_latency_ms pg_catalog.int4,
  p_ttfb_ms pg_catalog.int4,
  p_components pg_catalog.jsonb,
  p_status pg_catalog.text,
  p_error_code pg_catalog.text
)
returns setof public.serving_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interaction public.optimizer_project_serving_interactions%rowtype;
  v_project public.optimizer_projects%rowtype;
  v_existing public.serving_requests%rowtype;
  v_request public.serving_requests%rowtype;
  v_component pg_catalog.jsonb;
  v_usage pg_catalog.jsonb;
  v_payload pg_catalog.jsonb;
  v_sha pg_catalog.text;
  v_total_cost pg_catalog.numeric(20, 6);
  v_host_cost pg_catalog.numeric(20, 6);
  v_host_components pg_catalog.int2;
  v_customer_components pg_catalog.int2;
  v_billing_source pg_catalog.text;
  v_billing_breakdown pg_catalog.jsonb;
  v_input_tokens pg_catalog.int8;
  v_output_tokens pg_catalog.int8;
  v_cached_tokens pg_catalog.int8;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_server_interaction_id is null
     or p_latency_ms < 0 or p_ttfb_ms < 0
     or p_request is not null and pg_catalog.jsonb_typeof(p_request) <> 'object'
     or p_response is not null and pg_catalog.jsonb_typeof(p_response) <> 'object'
     or p_components is null
     or pg_catalog.jsonb_typeof(p_components) <> 'array'
     or pg_catalog.jsonb_array_length(p_components) <> 2
     or p_status not in ('ok', 'error')
     or (p_status = 'ok' and p_error_code is not null)
     or (
       p_status = 'error'
       and (
         p_error_code is null
         or p_error_code not in (
           'invalid_request', 'model_capability_invalid', 'provider_failed',
           'outcome_ambiguous', 'service_unavailable', 'internal_failure',
           'model_paused', 'credits_exhausted',
           'spend_limit_exceeded', 'token_limit_exceeded'
         )
       )
     ) then
    raise exception 'invalid Project serving settlement shape' using errcode = '22023';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'request', p_request,
    'response', p_response,
    'latency_ms', p_latency_ms,
    'ttfb_ms', p_ttfb_ms,
    'components', p_components,
    'status', p_status,
    'error_code', p_error_code
  );
  v_sha := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_payload::pg_catalog.text, 'UTF8')
    ),
    'hex'
  );
  select requests.* into v_existing
  from public.serving_requests as requests
  where requests.server_interaction_id = p_server_interaction_id;
  if v_existing.id is not null then
    if v_existing.settlement_sha256 <> v_sha then
      raise exception 'Project serving settlement replay drifted' using errcode = '23505';
    end if;
    return query select * from public.serving_requests
      where id = v_existing.id;
    return;
  end if;

  select interactions.* into v_interaction
  from public.optimizer_project_serving_interactions as interactions
  where interactions.server_interaction_id = p_server_interaction_id
    and interactions.state in ('admitted', 'dispatch_reserved')
  for update;
  if v_interaction.server_interaction_id is null then
    raise exception 'Project serving interaction was not admitted' using errcode = 'P0002';
  end if;
  select projects.* into v_project
  from public.optimizer_projects as projects
  where projects.id = v_interaction.project_id;
  if v_project.id is null then
    raise exception 'Project serving interaction lost its Project' using errcode = '23514';
  end if;

  for v_component in
    select value from pg_catalog.jsonb_array_elements(p_components)
  loop
    if pg_catalog.jsonb_typeof(v_component) <> 'object'
       or v_component - array[
         'operation_id', 'operation_ordinal', 'component', 'billing_source',
         'disposition', 'operation_count', 'usage', 'cost_usd',
         'cost_provenance', 'provider_connection_id',
         'provider_connection_revision'
       ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
       or not v_component ?& array[
         'operation_id', 'operation_ordinal', 'component', 'billing_source',
         'disposition', 'operation_count', 'usage', 'cost_usd',
         'cost_provenance'
       ]::pg_catalog.text[] then
      raise exception 'Project serving component has an unsupported shape'
        using errcode = '22023';
    end if;
    v_usage := v_component -> 'usage';
    if pg_catalog.jsonb_typeof(v_usage) <> 'object'
       or not v_usage ?& array['input_tokens', 'output_tokens']::pg_catalog.text[]
       or v_usage - array[
         'input_tokens', 'output_tokens', 'cached_input_tokens',
         'cache_write_input_tokens'
       ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
       or (v_usage ->> 'input_tokens')::pg_catalog.int8 < 0
       or (v_usage ->> 'output_tokens')::pg_catalog.int8 < 0
       or coalesce((v_usage ->> 'cached_input_tokens')::pg_catalog.int8, 0) < 0
       or coalesce((v_usage ->> 'cache_write_input_tokens')::pg_catalog.int8, 0) < 0
       or coalesce((v_usage ->> 'cached_input_tokens')::pg_catalog.int8, 0)
          > (v_usage ->> 'input_tokens')::pg_catalog.int8
       or coalesce((v_usage ->> 'cache_write_input_tokens')::pg_catalog.int8, 0)
          > (v_usage ->> 'input_tokens')::pg_catalog.int8 then
      raise exception 'Project serving component usage is invalid' using errcode = '22023';
    end if;
    if v_component ->> 'component' not in ('router_embedding', 'selected_candidate')
       or (v_component ->> 'operation_ordinal')::pg_catalog.int2 not in (1, 2)
       or (
         (v_component ->> 'component' = 'router_embedding'
          and (v_component ->> 'operation_ordinal')::pg_catalog.int2 <> 1)
         or (v_component ->> 'component' = 'selected_candidate'
          and (v_component ->> 'operation_ordinal')::pg_catalog.int2 <> 2)
       )
       or v_component ->> 'billing_source' not in (
         'host_managed', 'customer_managed', 'not_applicable'
       )
       or v_component ->> 'disposition' not in (
         'observed', 'locally_priced', 'reserved_ambiguous',
         'definitely_not_incurred'
       )
       or (v_component ->> 'operation_count')::pg_catalog.int2 not in (0, 1)
       or (v_component ->> 'cost_usd')::pg_catalog.numeric < 0
       or (v_component ->> 'cost_usd')::pg_catalog.numeric
          <> pg_catalog.round((v_component ->> 'cost_usd')::pg_catalog.numeric, 6)
       or (v_component ->> 'cost_usd')::pg_catalog.numeric
          > 99999999999999.999999
       or v_component ->> 'cost_provenance' not in ('observed', 'estimated') then
      raise exception 'Project serving component accounting is invalid'
        using errcode = '22023';
    end if;
    if v_component ->> 'billing_source' = 'not_applicable' then
      if v_component ->> 'disposition' <> 'definitely_not_incurred'
         or nullif(v_component ->> 'provider_connection_id', '') is not null
         or nullif(v_component ->> 'provider_connection_revision', '') is not null then
        raise exception 'not-applicable component must prove no provider operation'
          using errcode = '22023';
      end if;
    elsif v_component ->> 'billing_source' = 'host_managed' then
      if nullif(v_component ->> 'provider_connection_id', '') is not null
         or nullif(v_component ->> 'provider_connection_revision', '') is not null then
        raise exception 'host-managed component cannot name a customer connection'
          using errcode = '22023';
      end if;
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        v_interaction.connection_revisions
      ) as revisions(value)
      where (revisions.value ->> 'provider_connection_id')::pg_catalog.uuid
          = (v_component ->> 'provider_connection_id')::pg_catalog.uuid
        and (revisions.value ->> 'serving_revision')::pg_catalog.int8
          = (v_component ->> 'provider_connection_revision')::pg_catalog.int8
    ) then
      raise exception 'customer-managed component is outside its admitted connection set'
        using errcode = '42501';
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'component' = 'router_embedding'
      and (components.value ->> 'operation_ordinal')::pg_catalog.int2 = 1
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'component' = 'selected_candidate'
      and (components.value ->> 'operation_ordinal')::pg_catalog.int2 = 2
  ) <> 1 then
    raise exception 'Project serving settlement requires exactly two components'
      using errcode = '23514';
  end if;

  select
    pg_catalog.sum((components.value ->> 'cost_usd')::pg_catalog.numeric),
    pg_catalog.sum((components.value ->> 'cost_usd')::pg_catalog.numeric)
      filter (where components.value ->> 'billing_source' = 'host_managed'),
    pg_catalog.count(*) filter (
      where components.value ->> 'billing_source' = 'host_managed'
    ),
    pg_catalog.count(*) filter (
      where components.value ->> 'billing_source' = 'customer_managed'
    ),
    pg_catalog.max(
      (components.value -> 'usage' ->> 'input_tokens')::pg_catalog.int8
    ) filter (where components.value ->> 'component' = 'selected_candidate'),
    pg_catalog.max(
      (components.value -> 'usage' ->> 'output_tokens')::pg_catalog.int8
    ) filter (where components.value ->> 'component' = 'selected_candidate'),
    pg_catalog.max(coalesce(
      (components.value -> 'usage' ->> 'cached_input_tokens')::pg_catalog.int8, 0
    )) filter (where components.value ->> 'component' = 'selected_candidate')
    into v_total_cost, v_host_cost, v_host_components, v_customer_components,
         v_input_tokens, v_output_tokens, v_cached_tokens
  from pg_catalog.jsonb_array_elements(p_components) as components(value);
  v_host_cost := coalesce(v_host_cost, 0);
  v_billing_source := case
    when v_host_components = 0 and v_customer_components = 0 then 'none'
    when v_customer_components = 0 then 'host_managed'
    when v_host_components = 0 then 'customer_managed'
    else 'mixed'
  end;
  select pg_catalog.jsonb_object_agg(
    components.value ->> 'component',
    components.value ->> 'billing_source'
  ) into v_billing_breakdown
  from pg_catalog.jsonb_array_elements(p_components) as components(value);

  insert into public.serving_requests (
    org_id, endpoint_id, endpoint_label, api_key_id, byok,
    input_tokens, output_tokens, cached_tokens, cost_usd,
    latency_ms, ttfb_ms, status, error_message, request, response,
    optimizer_project_id, server_interaction_id,
    active_router_job_id, active_router_generation, settlement_sha256,
    optimizer_project_billing_source, optimizer_project_billing_breakdown
  ) values (
    v_interaction.org_id, v_interaction.project_id, v_project.slug,
    v_interaction.api_key_id, v_billing_source = 'customer_managed',
    v_input_tokens, v_output_tokens, v_cached_tokens, v_total_cost,
    p_latency_ms, p_ttfb_ms, p_status, p_error_code,
    case when v_interaction.store_bodies then p_request else null end,
    case when v_interaction.store_bodies then p_response else null end,
    v_interaction.project_id, p_server_interaction_id,
    v_interaction.job_id, v_interaction.generation, v_sha,
    v_billing_source, v_billing_breakdown
  ) returning * into v_request;

  insert into public.optimizer_project_serving_components (
    serving_request_id, operation_id, operation_ordinal, component,
    billing_source, disposition, operation_count, usage, cost_usd,
    cost_provenance, provider_connection_id, provider_connection_revision
  )
  select
    v_request.id,
    components.value ->> 'operation_id',
    (components.value ->> 'operation_ordinal')::pg_catalog.int2,
    components.value ->> 'component',
    components.value ->> 'billing_source',
    components.value ->> 'disposition',
    (components.value ->> 'operation_count')::pg_catalog.int2,
    components.value -> 'usage',
    (components.value ->> 'cost_usd')::pg_catalog.numeric,
    components.value ->> 'cost_provenance',
    nullif(components.value ->> 'provider_connection_id', '')::pg_catalog.uuid,
    nullif(components.value ->> 'provider_connection_revision', '')::pg_catalog.int8
  from pg_catalog.jsonb_array_elements(p_components) as components(value)
  order by (components.value ->> 'operation_ordinal')::pg_catalog.int2;

  update public.organizations
  set spend_usd = spend_usd + v_total_cost,
      billable_spend_usd = billable_spend_usd + v_host_cost
  where id = v_interaction.org_id;
  update public.provider_connections as connections
  set metered_spend_usd = connections.metered_spend_usd + totals.cost_usd
  from (
    select (components.value ->> 'provider_connection_id')::pg_catalog.uuid as id,
           pg_catalog.sum(
             (components.value ->> 'cost_usd')::pg_catalog.numeric
           ) as cost_usd
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'billing_source' = 'customer_managed'
    group by (components.value ->> 'provider_connection_id')::pg_catalog.uuid
  ) as totals
  where connections.id = totals.id;

  delete from public.optimizer_project_serving_interactions
  where server_interaction_id = p_server_interaction_id;
  return query select * from public.serving_requests where id = v_request.id;
end;
$$;

revoke all on function public.settle_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.settle_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
) to service_role;

create or replace function public.reconcile_optimizer_project_serving_interactions(
  p_limit pg_catalog.int4 default 100
)
returns pg_catalog.int4
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interaction public.optimizer_project_serving_interactions%rowtype;
  v_components pg_catalog.jsonb;
  v_error_code pg_catalog.text;
  v_latency_ms pg_catalog.int4;
  v_count pg_catalog.int4 := 0;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'invalid Project serving reconciliation limit'
      using errcode = '22023';
  end if;
  for v_interaction in
    select interactions.*
    from public.optimizer_project_serving_interactions as interactions
    where interactions.expires_at <= pg_catalog.clock_timestamp()
    order by interactions.expires_at
    limit p_limit
    for update skip locked
  loop
    if v_interaction.state = 'dispatch_reserved' then
      v_components := v_interaction.dispatch_components;
      v_error_code := 'outcome_ambiguous';
    else
      v_components := pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'operation_id', 'routed-operation-' || pg_catalog.substring(
            pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(
                v_interaction.server_interaction_id::pg_catalog.text
                  || E'\x1frouter_embedding',
                'UTF8'
              )),
              'hex'
            ),
            1,
            20
          ),
          'operation_ordinal', 1,
          'component', 'router_embedding',
          'billing_source', 'not_applicable',
          'disposition', 'definitely_not_incurred',
          'operation_count', 0,
          'usage', pg_catalog.jsonb_build_object(
            'input_tokens', 0, 'output_tokens', 0
          ),
          'cost_usd', '0.000000',
          'cost_provenance', 'estimated',
          'provider_connection_id', null,
          'provider_connection_revision', null
        ),
        pg_catalog.jsonb_build_object(
          'operation_id', 'routed-operation-' || pg_catalog.substring(
            pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(
                v_interaction.server_interaction_id::pg_catalog.text
                  || E'\x1fselected_candidate',
                'UTF8'
              )),
              'hex'
            ),
            1,
            20
          ),
          'operation_ordinal', 2,
          'component', 'selected_candidate',
          'billing_source', 'not_applicable',
          'disposition', 'definitely_not_incurred',
          'operation_count', 0,
          'usage', pg_catalog.jsonb_build_object(
            'input_tokens', 0, 'output_tokens', 0
          ),
          'cost_usd', '0.000000',
          'cost_provenance', 'estimated',
          'provider_connection_id', null,
          'provider_connection_revision', null
        )
      );
      v_error_code := 'service_unavailable';
    end if;
    v_latency_ms := least(
      2147483647,
      greatest(
        0,
        pg_catalog.floor(
          extract(epoch from (pg_catalog.clock_timestamp() - v_interaction.admitted_at))
            * 1000
        )
      )
    )::pg_catalog.int4;
    perform 1
    from public.settle_optimizer_project_serving_interaction(
      v_interaction.server_interaction_id,
      v_interaction.dispatch_request,
      pg_catalog.jsonb_build_object(
        'error', pg_catalog.jsonb_build_object('code', v_error_code)
      ),
      v_latency_ms,
      v_latency_ms,
      v_components,
      'error',
      v_error_code
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function public.require_optimizer_project_serving_component_pair()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id pg_catalog.uuid;
begin
  if tg_table_name = 'serving_requests' then
    if tg_op = 'DELETE' then
      v_request_id := old.id;
    else
      v_request_id := new.id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_request_id := old.serving_request_id;
    else
      v_request_id := new.serving_request_id;
    end if;
  end if;
  if not exists (
    select 1 from public.serving_requests as requests
    where requests.id = v_request_id and requests.optimizer_project_id is not null
  ) then
    return null;
  end if;
  if (
    select pg_catalog.count(*)
    from public.optimizer_project_serving_components as components
    where components.serving_request_id = v_request_id
  ) <> 2 or not exists (
    select 1 from public.optimizer_project_serving_components as components
    where components.serving_request_id = v_request_id
      and components.component = 'router_embedding'
      and components.operation_ordinal = 1
  ) or not exists (
    select 1 from public.optimizer_project_serving_components as components
    where components.serving_request_id = v_request_id
      and components.component = 'selected_candidate'
      and components.operation_ordinal = 2
  ) then
    raise exception 'Project serving request requires its exact component pair'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function public.require_optimizer_project_serving_component_pair()
  from public, anon, authenticated, service_role;

create constraint trigger serving_requests_require_project_component_pair
after insert or update on public.serving_requests
deferrable initially deferred
for each row execute function public.require_optimizer_project_serving_component_pair();

create constraint trigger serving_components_require_project_component_pair
after insert or update or delete on public.optimizer_project_serving_components
deferrable initially deferred
for each row execute function public.require_optimizer_project_serving_component_pair();

create function public.reject_optimizer_project_serving_component_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Project serving economics are immutable' using errcode = '55000';
end;
$$;

revoke all on function public.reject_optimizer_project_serving_component_mutation()
  from public, anon, authenticated, service_role;

create trigger optimizer_project_serving_components_immutable
before update or delete on public.optimizer_project_serving_components
for each row execute function public.reject_optimizer_project_serving_component_mutation();

create function public.guard_optimizer_project_serving_request_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (old.optimizer_project_id is not null or new.optimizer_project_id is not null) then
    raise exception 'Project serving requests are immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and old.optimizer_project_id is not null then
    perform public.apply_org_unbillable_spend_delta(
      old.org_id, -coalesce(old.cost_usd, 0)
    );
    update public.provider_connections as connections
    set metered_spend_usd = connections.metered_spend_usd - totals.cost_usd
    from (
      select components.provider_connection_id as id,
             pg_catalog.sum(components.cost_usd) as cost_usd
      from public.optimizer_project_serving_components as components
      where components.serving_request_id = old.id
        and components.provider_connection_id is not null
      group by components.provider_connection_id
    ) as totals
    where connections.id = totals.id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_optimizer_project_serving_request_mutation()
  from public, anon, authenticated, service_role;

create trigger serving_requests_guard_project_mutation
before update or delete on public.serving_requests
for each row execute function public.guard_optimizer_project_serving_request_mutation();

create or replace function public.track_serving_request_spend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op in ('UPDATE', 'DELETE') and old.optimizer_project_id is not null)
     or (tg_op in ('INSERT', 'UPDATE') and new.optimizer_project_id is not null) then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if old.byok or tg_op = 'DELETE' then
      perform public.apply_org_unbillable_spend_delta(
        old.org_id, -coalesce(old.cost_usd, 0)
      );
    else
      perform public.apply_org_spend_delta(old.org_id, -coalesce(old.cost_usd, 0));
    end if;
    if old.provider_connection_id is not null then
      update public.provider_connections
      set metered_spend_usd = metered_spend_usd - coalesce(old.cost_usd, 0)
      where id = old.provider_connection_id;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.byok then
      perform public.apply_org_unbillable_spend_delta(
        new.org_id, coalesce(new.cost_usd, 0)
      );
    else
      perform public.apply_org_spend_delta(new.org_id, coalesce(new.cost_usd, 0));
    end if;
    if new.provider_connection_id is not null then
      update public.provider_connections
      set metered_spend_usd = metered_spend_usd + coalesce(new.cost_usd, 0)
      where id = new.provider_connection_id;
    end if;
  end if;
  return null;
end;
$$;

create or replace function public.recompute_provider_connection_spend(
  target_connection pg_catalog.uuid
)
returns pg_catalog.numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_since pg_catalog.timestamptz;
  v_total pg_catalog.numeric;
begin
  select coalesce(connections.declared_balance_set_at, '-infinity'::pg_catalog.timestamptz)
    into v_since
  from public.provider_connections as connections
  where connections.id = target_connection;
  select coalesce(pg_catalog.sum(costs.cost_usd), 0) into v_total
  from (
    select requests.cost_usd
    from public.serving_requests as requests
    where requests.provider_connection_id = target_connection
      and requests.created_at >= v_since
    union all
    select components.cost_usd
    from public.optimizer_project_serving_components as components
    where components.provider_connection_id = target_connection
      and components.created_at >= v_since
  ) as costs;
  update public.provider_connections
  set metered_spend_usd = v_total
  where id = target_connection;
  return v_total;
end;
$$;

revoke all on function public.recompute_provider_connection_spend(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.recompute_provider_connection_spend(pg_catalog.uuid)
  to service_role;

-- Provider-free preparation is a durable Project operation separate from a
-- paid optimization attempt. Existing PR9 jobs retain their exact two-stage
-- recovery plan; every newly enqueued paid attempt must pin a matching
-- Project-scope prepared bundle and therefore never reruns preparation.
alter table public.optimizer_project_jobs
  add column operation pg_catalog.text;

update public.optimizer_project_jobs set operation = 'legacy_workflow';

alter table public.optimizer_project_jobs
  alter column operation set default 'optimization',
  alter column operation set not null,
  add constraint optimizer_project_jobs_operation_check check (
    operation in ('preparation', 'optimization', 'legacy_workflow')
  ),
  add column domain_stage pg_catalog.text check (
    domain_stage is null or domain_stage in (
      'preparing_traces', 'setup_required', 'building_world_model', 'optimizing_router',
      'completing_report', 'activating_endpoint', 'ready'
    )
  ),
  add column public_error_retryable pg_catalog.bool,
  add column public_error_action pg_catalog.text check (
    public_error_action is null or public_error_action in (
      'edit_traces', 'edit_setup', 'add_credit', 'retry',
      'wait_for_reconciliation', 'contact_support'
    )
  );

-- The schema transition is preceded by a bounded drain deployment that runs
-- the PR10 worker image against the PR9 RPCs without accepting work. Once this
-- migration lands, the old three-argument claim capability stays callable only
-- as an empty compatibility seam; only protocol-v2 workers can acquire either
-- backfilled legacy work or the new preparation/optimization operations.
alter table public.optimizer_project_workers
  add column protocol_version pg_catalog.int2 not null default 1
    check (protocol_version in (1, 2));

create or replace function public.claim_optimizer_project_job(
  p_worker_id pg_catalog.text,
  p_claim_token pg_catalog.text,
  p_lease_seconds pg_catalog.int4
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or pg_catalog.char_length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_claim_token is null or pg_catalog.char_length(p_claim_token) not between 43 and 128 then
    raise exception 'invalid claim token' using errcode = '22023';
  end if;
  if p_lease_seconds not between 15 and 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;
  return;
end;
$$;

create function public.claim_optimizer_project_job_v2(
  p_worker_id pg_catalog.text,
  p_claim_token pg_catalog.text,
  p_lease_seconds pg_catalog.int4
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id pg_catalog.uuid;
  v_job public.optimizer_project_jobs%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_worker_id is null or pg_catalog.char_length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_claim_token is null or pg_catalog.char_length(p_claim_token) not between 43 and 128 then
    raise exception 'invalid claim token' using errcode = '22023';
  end if;
  if p_lease_seconds not between 15 and 3600 then
    raise exception 'invalid lease duration' using errcode = '22023';
  end if;

  select jobs.id into v_job_id
  from public.optimizer_project_jobs as jobs
  where jobs.status = 'queued'
    and jobs.available_at <= pg_catalog.clock_timestamp()
  order by jobs.available_at, jobs.created_at, jobs.id
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  update public.optimizer_project_jobs as jobs
  set status = 'claimed',
      worker_id = p_worker_id,
      claim_token = p_claim_token,
      claim_generation = jobs.claim_generation + 1,
      attempt_count = jobs.attempt_count + 1,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where jobs.id = v_job_id
  returning jobs.* into v_job;

  perform public.optimizer_project_job_append_event(
    v_job.id,
    'claimed',
    v_job.stage,
    pg_catalog.jsonb_build_object('attempt', v_job.attempt_count)
  );
  return query select jobs.* from public.optimizer_project_jobs as jobs
    where jobs.id = v_job.id;
end;
$$;

create or replace function public.heartbeat_optimizer_project_worker(
  p_worker_id pg_catalog.text,
  p_accepting_work pg_catalog.bool
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or pg_catalog.char_length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid Project worker id' using errcode = '22023';
  end if;
  insert into public.optimizer_project_workers (
    worker_id, accepting_work, protocol_version, heartbeat_at
  ) values (
    p_worker_id, p_accepting_work, 1, pg_catalog.clock_timestamp()
  )
  on conflict (worker_id) do update
  set accepting_work = excluded.accepting_work,
      protocol_version = excluded.protocol_version,
      heartbeat_at = excluded.heartbeat_at;
end;
$$;

create function public.heartbeat_optimizer_project_worker_v2(
  p_worker_id pg_catalog.text,
  p_accepting_work pg_catalog.bool
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_worker_id is null or pg_catalog.char_length(p_worker_id) not between 1 and 128 then
    raise exception 'invalid Project worker id' using errcode = '22023';
  end if;
  insert into public.optimizer_project_workers (
    worker_id, accepting_work, protocol_version, heartbeat_at
  ) values (
    p_worker_id, p_accepting_work, 2, pg_catalog.clock_timestamp()
  )
  on conflict (worker_id) do update
  set accepting_work = excluded.accepting_work,
      protocol_version = excluded.protocol_version,
      heartbeat_at = excluded.heartbeat_at;
end;
$$;

revoke all on function public.claim_optimizer_project_job_v2(
  pg_catalog.text, pg_catalog.text, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.claim_optimizer_project_job_v2(
  pg_catalog.text, pg_catalog.text, pg_catalog.int4
) to service_role;
revoke all on function public.heartbeat_optimizer_project_worker_v2(
  pg_catalog.text, pg_catalog.bool
) from public, anon, authenticated;
grant execute on function public.heartbeat_optimizer_project_worker_v2(
  pg_catalog.text, pg_catalog.bool
) to service_role;

create or replace function public.record_optimizer_project_job_spend(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_spend_usd pg_catalog.numeric,
  p_lease_seconds pg_catalog.int4
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  select jobs.* into v_job
  from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status = 'running'
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if v_job.id is null then
    return;
  end if;
  if v_job.operation = 'preparation' then
    if p_spend_usd <> 0 then
      raise exception 'provider-free preparation cannot record provider spend'
        using errcode = '23514';
    end if;
    return query select * from public.optimizer_project_jobs where id = v_job.id;
    return;
  end if;
  if p_spend_usd < v_job.spend_usd
     or p_spend_usd < 0
     or p_lease_seconds not between 15 and 3600 then
    return;
  end if;
  update public.optimizer_project_jobs
  set spend_usd = p_spend_usd,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
  returning * into v_job;
  perform public.optimizer_project_job_append_event(
    v_job.id,
    'spend',
    v_job.stage,
    pg_catalog.jsonb_build_object('spend_usd', v_job.spend_usd)
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

update public.optimizer_project_jobs
set public_error_retryable = false,
    public_error_action = 'contact_support'
where public_error_code is not null;

alter table public.optimizer_project_jobs
  add constraint optimizer_project_jobs_public_error_metadata_shape check (
    (public_error_code is null and public_error_retryable is null
      and public_error_action is null)
    or (public_error_code is not null and public_error_retryable is not null
      and public_error_action is not null)
  );

alter table public.optimizer_project_job_events
  add column domain_stage pg_catalog.text check (
    domain_stage is null or domain_stage in (
      'preparing_traces', 'setup_required', 'building_world_model', 'optimizing_router',
      'completing_report', 'activating_endpoint', 'ready'
    )
  );

create table public.optimizer_project_preparation_inputs (
  job_id pg_catalog.uuid primary key
    references public.optimizer_project_jobs(id) on delete cascade,
  project_id pg_catalog.uuid not null,
  org_id pg_catalog.uuid not null references public.organizations(id) on delete cascade,
  source_id pg_catalog.uuid not null,
  source_kind pg_catalog.text not null,
  source_label pg_catalog.text not null,
  source_sha256 pg_catalog.text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size pg_catalog.int8 not null check (source_byte_size > 0),
  source_content_type pg_catalog.text not null,
  source_storage_bucket pg_catalog.text not null,
  source_storage_path pg_catalog.text not null,
  wmo_revision pg_catalog.text not null check (wmo_revision ~ '^[0-9a-f]{40}$'),
  wmo_project_id pg_catalog.text not null check (
    wmo_project_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  wmo_source_id pg_catalog.text not null check (
    wmo_source_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
  ),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (job_id, project_id, source_id, source_sha256),
  foreign key (job_id, project_id)
    references public.optimizer_project_jobs(id, project_id) on delete cascade,
  foreign key (source_id, project_id, org_id)
    references public.optimizer_project_trace_sources(id, project_id, org_id),
  foreign key (project_id, org_id)
    references public.optimizer_projects(id, org_id)
);

create index optimizer_project_preparation_inputs_source_idx
  on public.optimizer_project_preparation_inputs(project_id, source_id, source_sha256);

create table public.optimizer_project_preparation_outputs (
  job_id pg_catalog.uuid primary key,
  project_id pg_catalog.uuid not null,
  source_id pg_catalog.uuid not null,
  source_sha256 pg_catalog.text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_storage_bucket pg_catalog.text not null,
  bundle_storage_path pg_catalog.text not null,
  bundle_sha256 pg_catalog.text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_size_bytes pg_catalog.int8 not null check (bundle_size_bytes > 0),
  created_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  unique (
    job_id, project_id, source_id, source_sha256,
    bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes
  ),
  foreign key (job_id, project_id, source_id, source_sha256)
    references public.optimizer_project_preparation_inputs(
      job_id, project_id, source_id, source_sha256
    ) on delete cascade
);

create table public.optimizer_project_preparations (
  project_id pg_catalog.uuid primary key
    references public.optimizer_projects(id) on delete cascade,
  job_id pg_catalog.uuid not null unique,
  source_id pg_catalog.uuid not null,
  source_sha256 pg_catalog.text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_storage_bucket pg_catalog.text not null,
  bundle_storage_path pg_catalog.text not null,
  bundle_sha256 pg_catalog.text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_size_bytes pg_catalog.int8 not null check (bundle_size_bytes > 0),
  generation pg_catalog.int8 not null check (generation > 0),
  prepared_at pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key (
    job_id, project_id, source_id, source_sha256,
    bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes
  ) references public.optimizer_project_preparation_outputs(
    job_id, project_id, source_id, source_sha256,
    bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes
  ) on delete restrict
);

alter table public.optimizer_project_job_inputs
  add column prepared_job_id pg_catalog.uuid,
  add column prepared_bundle_storage_bucket pg_catalog.text,
  add column prepared_bundle_storage_path pg_catalog.text,
  add column prepared_bundle_sha256 pg_catalog.text check (
    prepared_bundle_sha256 is null or prepared_bundle_sha256 ~ '^[0-9a-f]{64}$'
  ),
  add column prepared_bundle_size_bytes pg_catalog.int8 check (
    prepared_bundle_size_bytes is null or prepared_bundle_size_bytes > 0
  ),
  add constraint optimizer_project_job_inputs_prepared_shape check (
    (prepared_job_id is null and prepared_bundle_storage_bucket is null
      and prepared_bundle_storage_path is null and prepared_bundle_sha256 is null
      and prepared_bundle_size_bytes is null)
    or (prepared_job_id is not null and prepared_bundle_storage_bucket is not null
      and prepared_bundle_storage_path is not null and prepared_bundle_sha256 is not null
      and prepared_bundle_size_bytes is not null)
  ),
  add constraint optimizer_project_job_inputs_prepared_bundle_fkey foreign key (
    prepared_job_id, project_id, source_id, source_sha256,
    prepared_bundle_storage_bucket, prepared_bundle_storage_path,
    prepared_bundle_sha256, prepared_bundle_size_bytes
  ) references public.optimizer_project_preparation_outputs(
    job_id, project_id, source_id, source_sha256,
    bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes
  ) on delete restrict;

alter table public.optimizer_project_preparation_inputs enable row level security;
alter table public.optimizer_project_preparation_outputs enable row level security;
alter table public.optimizer_project_preparations enable row level security;

revoke all on table public.optimizer_project_preparation_inputs
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_preparation_outputs
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_preparations
  from public, anon, authenticated, service_role;

grant select on table public.optimizer_project_preparation_inputs to service_role;
grant select on table public.optimizer_project_preparation_outputs to service_role;
grant select on table public.optimizer_project_preparations to service_role;

comment on table public.optimizer_project_preparations is
  'Single Project-scope provider-free bundle for the exact current immutable trace source.';

create function public.release_optimizer_project_provider_credential_revision(
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

create function public.pin_optimizer_project_prepared_bundle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation pg_catalog.text;
  v_prepared public.optimizer_project_preparations%rowtype;
begin
  select jobs.operation into v_operation
  from public.optimizer_project_jobs as jobs
  where jobs.id = new.job_id and jobs.project_id = new.project_id;
  if v_operation = 'legacy_workflow' then
    return new;
  end if;
  if v_operation <> 'optimization' then
    raise exception 'only optimization jobs may persist paid WMO inputs'
      using errcode = '23514';
  end if;
  select preparations.* into v_prepared
  from public.optimizer_project_preparations as preparations
  where preparations.project_id = new.project_id
    and preparations.source_id = new.source_id
    and preparations.source_sha256 = new.source_sha256
  for share;
  if v_prepared.project_id is null then
    raise exception 'Project trace source has not completed provider-free preparation'
      using errcode = '23514';
  end if;
  new.prepared_job_id := v_prepared.job_id;
  new.prepared_bundle_storage_bucket := v_prepared.bundle_storage_bucket;
  new.prepared_bundle_storage_path := v_prepared.bundle_storage_path;
  new.prepared_bundle_sha256 := v_prepared.bundle_sha256;
  new.prepared_bundle_size_bytes := v_prepared.bundle_size_bytes;
  return new;
end;
$$;

revoke all on function public.pin_optimizer_project_prepared_bundle()
  from public, anon, authenticated, service_role;

create trigger optimizer_project_job_inputs_pin_prepared_bundle
before insert on public.optimizer_project_job_inputs
for each row execute function public.pin_optimizer_project_prepared_bundle();

create function public.enqueue_optimizer_project_preparation(
  p_project_id pg_catalog.uuid,
  p_wmo_revision pg_catalog.text
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.optimizer_projects%rowtype;
  v_source public.optimizer_project_trace_sources%rowtype;
  v_object public.optimizer_project_trace_source_objects%rowtype;
  v_existing public.optimizer_project_jobs%rowtype;
  v_job public.optimizer_project_jobs%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_wmo_revision is null or p_wmo_revision !~ '^[0-9a-f]{40}$' then
    raise exception 'invalid WMO revision' using errcode = '22023';
  end if;
  select projects.* into v_project
  from public.optimizer_projects as projects
  where projects.id = p_project_id and projects.archived_at is null
  for update;
  if v_project.id is null then
    raise exception 'active Project does not exist' using errcode = 'P0002';
  end if;
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
  select objects.* into v_object
  from public.optimizer_project_trace_source_objects as objects
  where objects.source_id = v_source.id;
  if v_object.source_id is null then
    raise exception 'Project trace source object is missing' using errcode = '23514';
  end if;

  select jobs.* into v_existing
  from public.optimizer_project_preparations as preparations
  join public.optimizer_project_jobs as jobs on jobs.id = preparations.job_id
  where preparations.project_id = p_project_id
    and preparations.source_id = v_source.id
    and preparations.source_sha256 = v_source.sha256;
  if v_existing.id is not null then
    return query select * from public.optimizer_project_jobs where id = v_existing.id;
    return;
  end if;
  select jobs.* into v_existing
  from public.optimizer_project_jobs as jobs
  join public.optimizer_project_preparation_inputs as inputs on inputs.job_id = jobs.id
  where jobs.project_id = p_project_id
    and jobs.operation = 'preparation'
    and jobs.status in ('queued', 'claimed', 'running')
    and inputs.source_id = v_source.id
    and inputs.source_sha256 = v_source.sha256
  for update of jobs;
  if v_existing.id is not null then
    return query select * from public.optimizer_project_jobs where id = v_existing.id;
    return;
  end if;

  insert into public.optimizer_project_jobs(project_id, operation, domain_stage)
  values (p_project_id, 'preparation', 'preparing_traces')
  returning * into v_job;
  insert into public.optimizer_project_preparation_inputs (
    job_id, project_id, org_id,
    source_id, source_kind, source_label, source_sha256, source_byte_size,
    source_content_type, source_storage_bucket, source_storage_path,
    wmo_revision, wmo_project_id, wmo_source_id
  ) values (
    v_job.id, p_project_id, v_project.org_id,
    v_source.id, v_source.source_kind, v_source.source_label,
    v_source.sha256, v_source.byte_size, v_source.content_type,
    v_object.storage_bucket, v_object.storage_path,
    p_wmo_revision,
    'platform-project-' || pg_catalog.replace(p_project_id::pg_catalog.text, '-', ''),
    'platform-source-' || pg_catalog.replace(v_source.id::pg_catalog.text, '-', '')
  );
  insert into public.optimizer_project_current_jobs(project_id, job_id)
  values (p_project_id, v_job.id)
  on conflict on constraint optimizer_project_current_jobs_pkey do update
  set job_id = excluded.job_id, updated_at = pg_catalog.clock_timestamp();
  perform public.optimizer_project_job_append_event(
    v_job.id, 'queued', null,
    pg_catalog.jsonb_build_object('message', 'Trace preparation queued')
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

revoke all on function public.enqueue_optimizer_project_preparation(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.enqueue_optimizer_project_preparation(
  pg_catalog.uuid, pg_catalog.text
) to service_role;

-- New control-plane processes call versioned enqueue wrappers that translate
-- only the closed set of readiness races into stable, customer-safe SQLSTATEs.
-- The underlying functions retain their PR9 signatures for the brief drained
-- migration handoff; unknown constraint failures remain generic at the API.
create function public.enqueue_optimizer_project_preparation_v2(
  p_project_id pg_catalog.uuid,
  p_wmo_revision pg_catalog.text
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select jobs.*
  from public.enqueue_optimizer_project_preparation(
    p_project_id, p_wmo_revision
  ) as jobs;
exception
  when sqlstate '23514' then
    if sqlerrm in (
      'Project trace source is missing',
      'Project trace source object is missing'
    ) then
      raise exception 'Project trace source is not ready'
        using errcode = 'P1201', detail = 'trace_source_missing';
    end if;
    raise exception 'Project readiness changed'
      using errcode = 'P1200', detail = 'readiness_changed';
end;
$$;

create function public.enqueue_optimizer_project_wmo_job_v2(
  p_project_id pg_catalog.uuid,
  p_wmo_revision pg_catalog.text,
  p_available_platform_models pg_catalog.jsonb
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select jobs.*
  from public.enqueue_optimizer_project_wmo_job(
    p_project_id, p_wmo_revision, p_available_platform_models
  ) as jobs;
exception
  when sqlstate '23514' then
    case sqlerrm
      when 'Project trace source is missing' then
        raise exception 'Project trace source is not ready'
          using errcode = 'P1201', detail = 'trace_source_missing';
      when 'Project trace source object is missing' then
        raise exception 'Project trace source is not ready'
          using errcode = 'P1201', detail = 'trace_source_missing';
      when 'Project trace source has not completed provider-free preparation' then
        raise exception 'Project trace source must be prepared'
          using errcode = 'P1202', detail = 'trace_preparation_required';
      when 'Project setup is incomplete' then
        raise exception 'Project setup is incomplete'
          using errcode = 'P1203', detail = 'setup_incomplete';
      when 'Project setup model roles are incomplete' then
        raise exception 'Project setup is incomplete'
          using errcode = 'P1203', detail = 'setup_incomplete';
      when 'Project setup provider connection is unavailable' then
        raise exception 'Project provider connection is unavailable'
          using errcode = 'P1204', detail = 'provider_connection_missing';
      when 'Project setup Platform model is unavailable' then
        raise exception 'Project model capability is unavailable'
          using errcode = 'P1205', detail = 'model_capability_invalid';
      when 'Project ceiling exceeds unreserved Platform credit' then
        raise exception 'Project has insufficient Platform credit'
          using errcode = 'P1206', detail = 'insufficient_credit';
      else
        raise exception 'Project readiness changed'
          using errcode = 'P1200', detail = 'readiness_changed';
    end case;
end;
$$;

revoke all on function public.enqueue_optimizer_project_preparation_v2(
  pg_catalog.uuid, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.enqueue_optimizer_project_preparation_v2(
  pg_catalog.uuid, pg_catalog.text
) to service_role;
revoke all on function public.enqueue_optimizer_project_wmo_job_v2(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
) from public, anon, authenticated;
grant execute on function public.enqueue_optimizer_project_wmo_job_v2(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb
) to service_role;

create function public.get_optimizer_project_preparation_input(
  p_job_id pg_catalog.uuid
)
returns setof public.optimizer_project_preparation_inputs
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select inputs.* from public.optimizer_project_preparation_inputs as inputs
  where inputs.job_id = p_job_id;
end;
$$;

revoke all on function public.get_optimizer_project_preparation_input(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_preparation_input(pg_catalog.uuid)
  to service_role;

create function public.get_optimizer_project_prepared_bundle(
  p_job_id pg_catalog.uuid
)
returns table (
  prepared_job_id pg_catalog.uuid,
  bundle_storage_bucket pg_catalog.text,
  bundle_storage_path pg_catalog.text,
  bundle_sha256 pg_catalog.text,
  bundle_size_bytes pg_catalog.int8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select inputs.prepared_job_id, inputs.prepared_bundle_storage_bucket,
         inputs.prepared_bundle_storage_path, inputs.prepared_bundle_sha256,
         inputs.prepared_bundle_size_bytes
  from public.optimizer_project_job_inputs as inputs
  where inputs.job_id = p_job_id and inputs.prepared_job_id is not null;
end;
$$;

revoke all on function public.get_optimizer_project_prepared_bundle(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_prepared_bundle(pg_catalog.uuid)
  to service_role;

create function public.record_optimizer_project_preparation_output(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_bundle_storage_bucket pg_catalog.text,
  p_bundle_storage_path pg_catalog.text,
  p_bundle_sha256 pg_catalog.text,
  p_bundle_size_bytes pg_catalog.int8
)
returns setof public.optimizer_project_preparation_outputs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input public.optimizer_project_preparation_inputs%rowtype;
  v_existing public.optimizer_project_preparation_outputs%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform public.assert_optimizer_project_wmo_fence(
    p_job_id, p_claim_token, p_claim_generation
  );
  if p_bundle_storage_bucket is null
     or pg_catalog.char_length(p_bundle_storage_bucket) not between 1 and 128
     or p_bundle_storage_bucket ~ '[[:cntrl:]]'
     or p_bundle_storage_path is null
     or pg_catalog.char_length(p_bundle_storage_path) not between 1 and 1024
     or p_bundle_storage_path ~ '(^/|(^|/)\.\.?(/|$)|[[:cntrl:]])'
     or p_bundle_sha256 !~ '^[0-9a-f]{64}$'
     or p_bundle_size_bytes <= 0 then
    raise exception 'invalid Project preparation bundle identity' using errcode = '22023';
  end if;
  select inputs.* into v_input
  from public.optimizer_project_preparation_inputs as inputs
  join public.optimizer_project_jobs as jobs on jobs.id = inputs.job_id
  where inputs.job_id = p_job_id and jobs.operation = 'preparation';
  if v_input.job_id is null then
    raise exception 'Project preparation input does not exist' using errcode = 'P0002';
  end if;
  select outputs.* into v_existing
  from public.optimizer_project_preparation_outputs as outputs
  where outputs.job_id = p_job_id;
  if v_existing.job_id is not null then
    if v_existing.project_id <> v_input.project_id
       or v_existing.source_id <> v_input.source_id
       or v_existing.source_sha256 <> v_input.source_sha256
       or v_existing.bundle_storage_bucket <> p_bundle_storage_bucket
       or v_existing.bundle_storage_path <> p_bundle_storage_path
       or v_existing.bundle_sha256 <> p_bundle_sha256
       or v_existing.bundle_size_bytes <> p_bundle_size_bytes then
      raise exception 'Project preparation output replay drifted' using errcode = '23505';
    end if;
    return query select * from public.optimizer_project_preparation_outputs
      where job_id = p_job_id;
    return;
  end if;
  insert into public.optimizer_project_preparation_outputs (
    job_id, project_id, source_id, source_sha256,
    bundle_storage_bucket, bundle_storage_path, bundle_sha256, bundle_size_bytes
  ) values (
    p_job_id, v_input.project_id, v_input.source_id, v_input.source_sha256,
    p_bundle_storage_bucket, p_bundle_storage_path, p_bundle_sha256, p_bundle_size_bytes
  );
  return query select * from public.optimizer_project_preparation_outputs
    where job_id = p_job_id;
end;
$$;

revoke all on function public.record_optimizer_project_preparation_output(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.record_optimizer_project_preparation_output(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) to service_role;

create function public.get_optimizer_project_preparation_output(
  p_job_id pg_catalog.uuid
)
returns setof public.optimizer_project_preparation_outputs
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select outputs.*
  from public.optimizer_project_preparation_outputs as outputs
  where outputs.job_id = p_job_id;
end;
$$;

revoke all on function public.get_optimizer_project_preparation_output(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_preparation_output(pg_catalog.uuid)
  to service_role;

create function public.initialize_optimizer_project_domain_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'claimed' and new.status = 'running'
     and new.domain_stage is null then
    new.domain_stage := case
      when new.stage = 'preparing_traces' then 'preparing_traces'
      when new.stage = 'wmo_workflow' then 'building_world_model'
      else null
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.initialize_optimizer_project_domain_stage()
  from public, anon, authenticated, service_role;

create trigger optimizer_project_jobs_initialize_domain_stage
before update of status, stage on public.optimizer_project_jobs
for each row execute function public.initialize_optimizer_project_domain_stage();

create or replace function public.optimizer_project_job_append_event(
  p_job_id pg_catalog.uuid,
  p_event_type pg_catalog.text,
  p_stage pg_catalog.text,
  p_payload pg_catalog.jsonb
)
returns pg_catalog.int8
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq pg_catalog.int8;
  v_domain_stage pg_catalog.text;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or pg_catalog.octet_length(p_payload::pg_catalog.text) > 8192 then
    raise exception 'invalid public Project job event payload' using errcode = '22023';
  end if;
  update public.optimizer_project_jobs
  set last_event_seq = last_event_seq + 1
  where id = p_job_id
  returning last_event_seq, domain_stage into v_seq, v_domain_stage;
  if v_seq is null then
    raise exception 'Project job does not exist' using errcode = 'P0002';
  end if;
  insert into public.optimizer_project_job_events (
    job_id, seq, event_type, stage, domain_stage, payload
  ) values (
    p_job_id, v_seq, p_event_type, p_stage, v_domain_stage, p_payload
  );
  delete from public.optimizer_project_job_events
  where job_id = p_job_id and seq <= v_seq - 512;
  return v_seq;
end;
$$;

revoke all on function public.optimizer_project_job_append_event(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) from public, anon, authenticated;

create function public.optimizer_project_domain_stage_rank(p_stage pg_catalog.text)
returns pg_catalog.int2
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_stage
    when 'preparing_traces' then 1
    when 'setup_required' then 2
    when 'building_world_model' then 3
    when 'optimizing_router' then 4
    when 'completing_report' then 5
    when 'activating_endpoint' then 6
    when 'ready' then 7
    else 0
  end::pg_catalog.int2;
$$;

revoke all on function public.optimizer_project_domain_stage_rank(pg_catalog.text)
  from public, anon, authenticated;

create function public.update_optimizer_project_job_domain_progress(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_domain_stage pg_catalog.text,
  p_progress pg_catalog.jsonb,
  p_lease_seconds pg_catalog.int4
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if public.optimizer_project_domain_stage_rank(p_domain_stage) = 0
     or p_progress is null
     or pg_catalog.jsonb_typeof(p_progress) <> 'object'
     or pg_catalog.octet_length(p_progress::pg_catalog.text) > 8192
     or p_lease_seconds not between 15 and 3600 then
    raise exception 'invalid Project domain progress' using errcode = '22023';
  end if;
  update public.optimizer_project_jobs
  set domain_stage = p_domain_stage,
      progress = p_progress,
      heartbeat_at = pg_catalog.clock_timestamp(),
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
    and claim_token = p_claim_token
    and claim_generation = p_claim_generation
    and status = 'running'
    and lease_expires_at > pg_catalog.clock_timestamp()
    and public.optimizer_project_domain_stage_rank(p_domain_stage)
      >= public.optimizer_project_domain_stage_rank(domain_stage)
    and (
      (operation = 'preparation' and p_domain_stage = 'preparing_traces')
      or (operation in ('optimization', 'legacy_workflow')
        and p_domain_stage in (
          'building_world_model', 'optimizing_router', 'completing_report',
          'activating_endpoint'
        ))
    )
  returning * into v_job;
  if v_job.id is null then
    return;
  end if;
  perform public.optimizer_project_job_append_event(
    v_job.id, 'progress', v_job.stage, p_progress
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

revoke all on function public.update_optimizer_project_job_domain_progress(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.update_optimizer_project_job_domain_progress(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8,
  pg_catalog.text, pg_catalog.jsonb, pg_catalog.int4
) to service_role;

create function public.optimizer_project_error_retryable(p_code pg_catalog.text)
returns pg_catalog.bool
language sql
immutable
security definer
set search_path = ''
as $$
  select p_code in (
    'active_job_exists', 'provider_failed', 'bundle_invalid',
    'activation_failed', 'worker_unavailable', 'internal_failure'
  );
$$;

create function public.optimizer_project_error_action(p_code pg_catalog.text)
returns pg_catalog.text
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_code
    when 'trace_source_missing' then 'edit_traces'
    when 'source_superseded' then 'edit_traces'
    when 'setup_incomplete' then 'edit_setup'
    when 'provider_connection_missing' then 'edit_setup'
    when 'model_capability_invalid' then 'edit_setup'
    when 'insufficient_credit' then 'add_credit'
    when 'active_job_exists' then 'wait_for_reconciliation'
    when 'outcome_ambiguous' then 'wait_for_reconciliation'
    when 'provider_failed' then 'retry'
    when 'bundle_invalid' then 'retry'
    when 'activation_failed' then 'retry'
    when 'worker_unavailable' then 'retry'
    else 'contact_support'
  end;
$$;

revoke all on function public.optimizer_project_error_retryable(pg_catalog.text)
  from public, anon, authenticated;
revoke all on function public.optimizer_project_error_action(pg_catalog.text)
  from public, anon, authenticated;

-- Completion owns both Project-scope preparation readiness and the latest
-- successful active-router pointer. These pointers move in the same
-- transaction as the corresponding terminal job event.
create or replace function public.finish_optimizer_project_job(
  p_job_id pg_catalog.uuid,
  p_claim_token pg_catalog.text,
  p_claim_generation pg_catalog.int8,
  p_status pg_catalog.text,
  p_public_error_code pg_catalog.text,
  p_public_error_message pg_catalog.text,
  p_platform_provider_revision pg_catalog.text default null
)
returns setof public.optimizer_project_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.optimizer_project_jobs%rowtype;
  v_input public.optimizer_project_job_inputs%rowtype;
  v_preparation_input public.optimizer_project_preparation_inputs%rowtype;
  v_preparation_output public.optimizer_project_preparation_outputs%rowtype;
  v_commit public.optimizer_project_wmo_stage_commits%rowtype;
  v_preflight public.optimizer_project_router_preflights%rowtype;
  v_project public.optimizer_projects%rowtype;
  v_payload pg_catalog.jsonb;
  v_connection_sha pg_catalog.text;
  v_effective_status pg_catalog.text := p_status;
  v_error_code pg_catalog.text := p_public_error_code;
  v_error_message pg_catalog.text := p_public_error_message;
  v_retryable pg_catalog.bool;
  v_action pg_catalog.text;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_status not in ('completed', 'failed', 'ambiguous') then
    raise exception 'invalid Project job terminal state' using errcode = '22023';
  end if;
  if (p_status = 'completed') <>
     (p_public_error_code is null and p_public_error_message is null) then
    raise exception 'Project job terminal error shape is invalid' using errcode = '22023';
  end if;
  select jobs.* into v_job
  from public.optimizer_project_jobs as jobs
  where jobs.id = p_job_id
    and jobs.claim_token = p_claim_token
    and jobs.claim_generation = p_claim_generation
    and jobs.status in ('claimed', 'running')
    and jobs.lease_expires_at > pg_catalog.clock_timestamp()
  for update;
  if v_job.id is null then
    return;
  end if;

  if v_job.operation = 'preparation' then
    if p_status = 'ambiguous' then
      raise exception 'provider-free preparation cannot be ambiguous'
        using errcode = '23514';
    end if;
    select inputs.* into v_preparation_input
    from public.optimizer_project_preparation_inputs as inputs
    where inputs.job_id = p_job_id;
    if v_preparation_input.job_id is null then
      raise exception 'Project preparation input is absent' using errcode = '23514';
    end if;
    if p_status = 'completed' then
      select outputs.* into v_preparation_output
      from public.optimizer_project_preparation_outputs as outputs
      where outputs.job_id = p_job_id;
      if v_preparation_output.job_id is null or not exists (
        select 1 from public.optimizer_project_stage_pointers as pointers
        where pointers.project_id = v_preparation_input.project_id
          and pointers.job_id = p_job_id
          and pointers.stage = 'preparing_traces'
          and pointers.sha256 = v_preparation_output.bundle_sha256
      ) then
        raise exception 'completed preparation requires its exact verified bundle pointer'
          using errcode = '23514';
      end if;
      perform 1
      from public.optimizer_project_trace_current_sources as current_sources
      where current_sources.project_id = v_preparation_input.project_id
        and current_sources.source_id = v_preparation_input.source_id
        and current_sources.org_id = v_preparation_input.org_id
      for update;
      if not found then
        v_effective_status := 'failed';
        v_error_code := 'source_superseded';
        v_error_message := 'The trace source changed while preparation was running.';
      else
        insert into public.optimizer_project_preparations (
          project_id, job_id, source_id, source_sha256,
          bundle_storage_bucket, bundle_storage_path, bundle_sha256,
          bundle_size_bytes, generation, prepared_at
        ) values (
          v_preparation_input.project_id, p_job_id,
          v_preparation_input.source_id, v_preparation_input.source_sha256,
          v_preparation_output.bundle_storage_bucket,
          v_preparation_output.bundle_storage_path,
          v_preparation_output.bundle_sha256,
          v_preparation_output.bundle_size_bytes, 1,
          pg_catalog.clock_timestamp()
        )
        on conflict on constraint optimizer_project_preparations_pkey do update
        set job_id = excluded.job_id,
            source_id = excluded.source_id,
            source_sha256 = excluded.source_sha256,
            bundle_storage_bucket = excluded.bundle_storage_bucket,
            bundle_storage_path = excluded.bundle_storage_path,
            bundle_sha256 = excluded.bundle_sha256,
            bundle_size_bytes = excluded.bundle_size_bytes,
            generation = public.optimizer_project_preparations.generation + 1,
            prepared_at = excluded.prepared_at;
      end if;
    end if;
  else
    select inputs.* into v_input
    from public.optimizer_project_job_inputs as inputs
    where inputs.job_id = p_job_id;
    if v_input.job_id is null then
      raise exception 'paid Project job input is absent' using errcode = '23514';
    end if;
    if p_status = 'completed' then
      select projects.* into v_project
      from public.optimizer_projects as projects
      where projects.id = v_input.project_id
      for update;
      if v_project.id is null or v_project.archived_at is not null then
        raise exception 'completed Project router requires an active Project'
          using errcode = '23514';
      end if;
      perform 1 from public.optimizer_project_current_jobs as current_jobs
      where current_jobs.project_id = v_input.project_id
        and current_jobs.job_id = p_job_id
      for update;
      if not found then
        raise exception 'only the current Project job may activate a router'
          using errcode = '23514';
      end if;
      select commits.* into v_commit
      from public.optimizer_project_wmo_stage_commits as commits
      where commits.job_id = p_job_id and commits.stage = 'completing_report';
      if v_commit.job_id is null or not exists (
        select 1 from public.optimizer_project_stage_pointers as pointers
        where pointers.project_id = v_input.project_id
          and pointers.job_id = p_job_id
          and pointers.stage = 'wmo_workflow'
          and pointers.sha256 = v_commit.bundle_sha256
      ) then
        raise exception 'completed Project job requires its exact final WMO bundle'
          using errcode = '23514';
      end if;
      select preflights.* into v_preflight
      from public.optimizer_project_router_preflights as preflights
      where preflights.job_id = p_job_id;
      if v_preflight.job_id is null
         or v_preflight.project_id <> v_input.project_id
         or v_preflight.bundle_sha256 <> v_commit.bundle_sha256
         or v_preflight.policy_id <> v_commit.policy_id
         or v_preflight.catalog_artifact_id <> v_commit.catalog_artifact_id
         or v_preflight.catalog_manifest_sha256 <> v_commit.catalog_manifest_sha256
         or v_preflight.setup_version <> v_input.setup_version
         or v_preflight.setup_sha256 <> v_input.setup_sha256
         or not exists (
           select 1 from public.optimizer_project_results as results
           where results.job_id = p_job_id and results.project_id = v_input.project_id
         ) then
        raise exception 'completed Project router lacks exact activation evidence'
          using errcode = '23514';
      end if;
      if p_platform_provider_revision is null
         or pg_catalog.char_length(p_platform_provider_revision) not between 1 and 128
         or p_platform_provider_revision ~ '[[:cntrl:]]'
         or p_platform_provider_revision <> v_preflight.platform_provider_revision then
        raise exception 'Platform provider revision changed after activation preflight'
          using errcode = '23514';
      end if;
      v_connection_sha := pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            public.optimizer_project_lock_serving_connection_revisions(p_job_id)::pg_catalog.text,
            'UTF8'
          )
        ),
        'hex'
      );
      if v_connection_sha <> v_preflight.connection_revision_sha256 then
        raise exception 'Project serving connection changed after activation preflight'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from public.list_legacy_serving_endpoints(v_input.org_id) as legacy
        where legacy.endpoint_name = v_project.slug
      ) then
        raise exception 'Project model name collides with eligible legacy serving'
          using errcode = '23505';
      end if;
      insert into public.optimizer_project_serving_settings(project_id)
      values (v_input.project_id)
      on conflict on constraint optimizer_project_serving_settings_pkey do nothing;
      insert into public.optimizer_project_active_routers (
        project_id, job_id, generation, activated_at
      ) values (
        v_input.project_id, p_job_id, 1, pg_catalog.clock_timestamp()
      )
      on conflict on constraint optimizer_project_active_routers_pkey do update
      set job_id = excluded.job_id,
          generation = public.optimizer_project_active_routers.generation + 1,
          activated_at = excluded.activated_at;
    elsif p_status = 'ambiguous' and not exists (
      select 1
      from public.optimizer_project_wmo_hazards as hazards
      join public.optimizer_project_wmo_failed_ledgers as ledgers using (job_id)
      where hazards.job_id = p_job_id and hazards.state = 'ambiguous'
    ) then
      raise exception 'ambiguous Project job requires reconciled failed WMO evidence'
        using errcode = '23514';
    end if;
    if p_status <> 'ambiguous' and exists (
      select 1 from public.optimizer_project_wmo_hazards as hazards
      where hazards.job_id = p_job_id and hazards.state = 'ambiguous'
    ) then
      raise exception 'ambiguous provider evidence requires ambiguous terminal state'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from public.optimizer_project_wmo_hazards as hazards
      where hazards.job_id = p_job_id and hazards.state = 'active'
    ) then
      raise exception 'Project job cannot finish with an active provider hazard'
        using errcode = '23514';
    end if;
  end if;

  v_retryable := case when v_error_code is null then null
    else public.optimizer_project_error_retryable(v_error_code) end;
  v_action := case when v_error_code is null then null
    else public.optimizer_project_error_action(v_error_code) end;
  update public.optimizer_project_jobs
  set status = v_effective_status,
      domain_stage = case
        when v_effective_status = 'completed' and v_job.operation = 'preparation'
          then 'setup_required'
        when v_effective_status = 'completed' then 'ready'
        else domain_stage
      end,
      public_error_code = v_error_code,
      public_error_message = v_error_message,
      public_error_retryable = v_retryable,
      public_error_action = v_action,
      worker_id = null,
      claim_token = null,
      heartbeat_at = null,
      lease_expires_at = null,
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where id = p_job_id
  returning * into v_job;

  update public.optimizer_project_credit_reservations
  set state = 'released', released_at = pg_catalog.clock_timestamp()
  where job_id = p_job_id and state = 'reserved';
  v_payload := case when v_effective_status = 'completed' then
    pg_catalog.jsonb_build_object('message', 'Project work completed')
  else pg_catalog.jsonb_build_object(
    'error_code', v_error_code, 'message', v_error_message,
    'retryable', v_retryable, 'action', v_action
  ) end;
  perform public.optimizer_project_job_append_event(
    v_job.id, v_effective_status, v_job.stage, v_payload
  );
  return query select * from public.optimizer_project_jobs where id = v_job.id;
end;
$$;

create function public.get_optimizer_project_preparation_status(
  p_project_id pg_catalog.uuid
)
returns table (
  state pg_catalog.text,
  job_id pg_catalog.uuid,
  prepared_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_source public.optimizer_project_trace_sources%rowtype;
  v_prepared public.optimizer_project_preparations%rowtype;
  v_job public.optimizer_project_jobs%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if not exists (
    select 1 from public.optimizer_projects as projects
    where projects.id = p_project_id
  ) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  select sources.* into v_source
  from public.optimizer_project_trace_current_sources as current_sources
  join public.optimizer_project_trace_sources as sources
    on sources.id = current_sources.source_id
   and sources.project_id = current_sources.project_id
   and sources.org_id = current_sources.org_id
  where current_sources.project_id = p_project_id;
  if v_source.id is null then
    return query select 'not_started'::pg_catalog.text, null::pg_catalog.uuid,
      null::pg_catalog.timestamptz;
    return;
  end if;
  select preparations.* into v_prepared
  from public.optimizer_project_preparations as preparations
  where preparations.project_id = p_project_id;
  if v_prepared.project_id is not null
     and v_prepared.source_id = v_source.id
     and v_prepared.source_sha256 = v_source.sha256 then
    return query select 'ready'::pg_catalog.text, v_prepared.job_id,
      v_prepared.prepared_at;
    return;
  end if;
  select jobs.* into v_job
  from public.optimizer_project_jobs as jobs
  join public.optimizer_project_preparation_inputs as inputs
    on inputs.job_id = jobs.id
  where jobs.project_id = p_project_id
    and jobs.operation = 'preparation'
    and inputs.source_id = v_source.id
    and inputs.source_sha256 = v_source.sha256
  order by jobs.created_at desc, jobs.id desc
  limit 1;
  if v_job.id is not null then
    return query select case
      when v_job.status = 'queued' then 'queued'
      when v_job.status in ('claimed', 'running') then 'preparing'
      when v_job.status = 'completed' then 'superseded'
      else 'failed'
    end::pg_catalog.text, v_job.id, null::pg_catalog.timestamptz;
    return;
  end if;
  return query select case
    when v_prepared.project_id is not null then 'superseded'
    else 'not_started'
  end::pg_catalog.text, v_prepared.job_id, null::pg_catalog.timestamptz;
end;
$$;

revoke all on function public.get_optimizer_project_preparation_status(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_preparation_status(pg_catalog.uuid)
  to service_role;

create function public.get_optimizer_project_result_projection(
  p_project_id pg_catalog.uuid
)
returns table (
  project_id pg_catalog.uuid,
  model pg_catalog.text,
  router_id pg_catalog.uuid,
  active_generation pg_catalog.int8,
  active pg_catalog.bool,
  archived pg_catalog.bool,
  activated_at pg_catalog.timestamptz,
  current_job_active pg_catalog.bool,
  completed_at pg_catalog.timestamptz,
  report pg_catalog.jsonb,
  build_spend pg_catalog.jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.optimizer_project_wmo_require_service_role();
  return query
  select projects.id, projects.slug, active.job_id, active.generation,
         active.project_id is not null and projects.archived_at is null,
         projects.archived_at is not null,
         active.activated_at,
         coalesce(current_jobs.job_id = active.job_id, false),
         jobs.completed_at, results.report, results.build_spend
  from public.optimizer_projects as projects
  left join public.optimizer_project_active_routers as active
    on active.project_id = projects.id
  left join public.optimizer_project_current_jobs as current_jobs
    on current_jobs.project_id = projects.id
  left join public.optimizer_project_jobs as jobs on jobs.id = active.job_id
  left join public.optimizer_project_results as results
    on results.job_id = active.job_id and results.project_id = projects.id
  where projects.id = p_project_id;
end;
$$;

revoke all on function public.get_optimizer_project_result_projection(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_result_projection(pg_catalog.uuid)
  to service_role;

create function public.get_optimizer_project_serving_usage(
  p_project_id pg_catalog.uuid
)
returns table (
  project_id pg_catalog.uuid,
  period_start pg_catalog.timestamptz,
  period_end pg_catalog.timestamptz,
  spend_used_usd pg_catalog.text,
  tokens_used pg_catalog.int8,
  request_count pg_catalog.int8,
  spend_limit_usd pg_catalog.text,
  token_limit pg_catalog.int8,
  spend_alert_fraction pg_catalog.text,
  spend_alert_triggered pg_catalog.bool,
  spend_limit_exhausted pg_catalog.bool,
  token_limit_exhausted pg_catalog.bool
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.optimizer_project_serving_settings%rowtype;
  v_period_start pg_catalog.timestamptz;
  v_period_end pg_catalog.timestamptz;
  v_spend pg_catalog.numeric(20, 6);
  v_tokens pg_catalog.int8;
  v_requests pg_catalog.int8;
begin
  perform public.optimizer_project_wmo_require_service_role();
  perform * from public.get_optimizer_project_serving_settings(p_project_id);
  select settings.* into v_settings
  from public.optimizer_project_serving_settings as settings
  where settings.project_id = p_project_id;
  if v_settings.project_id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  v_period_start := (
    pg_catalog.date_trunc(
      'month', pg_catalog.statement_timestamp() at time zone 'UTC'
    ) at time zone 'UTC'
  );
  v_period_end := v_period_start + pg_catalog.interval '1 month';
  select coalesce(pg_catalog.sum(requests.cost_usd), 0),
         coalesce(pg_catalog.sum(requests.input_tokens + requests.output_tokens), 0),
         pg_catalog.count(*)
    into v_spend, v_tokens, v_requests
  from public.serving_requests as requests
  where requests.optimizer_project_id = p_project_id
    and requests.created_at >= v_period_start
    and requests.created_at < v_period_end;
  return query select
    p_project_id, v_period_start, v_period_end, v_spend::pg_catalog.text,
    v_tokens, v_requests, v_settings.monthly_spend_limit_usd::pg_catalog.text,
    v_settings.monthly_token_limit, v_settings.spend_alert_fraction::pg_catalog.text,
    v_settings.monthly_spend_limit_usd is not null
      and v_settings.spend_alert_fraction is not null
      and v_spend >= (
        v_settings.monthly_spend_limit_usd * v_settings.spend_alert_fraction
      ),
    v_settings.monthly_spend_limit_usd is not null
      and v_spend >= v_settings.monthly_spend_limit_usd,
    v_settings.monthly_token_limit is not null
      and v_tokens >= v_settings.monthly_token_limit;
end;
$$;

revoke all on function public.get_optimizer_project_serving_usage(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.get_optimizer_project_serving_usage(pg_catalog.uuid)
  to service_role;

drop function public.list_serving_requests(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.uuid, pg_catalog.int4
);

create function public.list_serving_requests(
  in_org pg_catalog.uuid,
  in_endpoint pg_catalog.uuid default null,
  in_project pg_catalog.uuid default null,
  in_status pg_catalog.text default null,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_cursor_ts pg_catalog.timestamptz default null,
  in_cursor_id pg_catalog.uuid default null,
  in_limit pg_catalog.int4 default 50
)
returns table (
  id pg_catalog.uuid,
  endpoint_id pg_catalog.uuid,
  endpoint_label pg_catalog.text,
  project_id pg_catalog.uuid,
  billing_source pg_catalog.text,
  billing_components pg_catalog.jsonb,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cached_tokens pg_catalog.int8,
  cost_usd pg_catalog.numeric,
  latency_ms pg_catalog.int4,
  ttfb_ms pg_catalog.int4,
  status pg_catalog.text,
  error_message pg_catalog.text,
  created_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  if in_endpoint is not null and in_project is not null then
    raise exception 'endpoint and Project filters are mutually exclusive'
      using errcode = '22023';
  end if;
  return query
  select requests.id, requests.endpoint_id, requests.endpoint_label,
         requests.optimizer_project_id,
         requests.optimizer_project_billing_source,
         requests.optimizer_project_billing_breakdown,
         requests.input_tokens, requests.output_tokens, requests.cached_tokens,
         requests.cost_usd, requests.latency_ms, requests.ttfb_ms,
         requests.status, requests.error_message, requests.created_at
  from public.serving_requests as requests
  where requests.org_id = in_org
    and (in_endpoint is null or requests.endpoint_id = in_endpoint)
    and (in_project is null or requests.optimizer_project_id = in_project)
    and (in_status is null or requests.status = in_status)
    and (in_after is null or requests.created_at >= in_after)
    and (in_before is null or requests.created_at < in_before)
    and (
      in_cursor_ts is null or in_cursor_id is null
      or (requests.created_at, requests.id) < (in_cursor_ts, in_cursor_id)
    )
  order by requests.created_at desc, requests.id desc
  limit cap;
end;
$$;

revoke all on function public.list_serving_requests(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.uuid, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.list_serving_requests(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.uuid, pg_catalog.int4
) to service_role;

drop function public.serving_request_stats(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz
);

create function public.serving_request_stats(
  in_org pg_catalog.uuid,
  in_endpoint pg_catalog.uuid default null,
  in_project pg_catalog.uuid default null,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null
)
returns table (
  request_count pg_catalog.int8,
  error_count pg_catalog.int8,
  unpriced_count pg_catalog.int8,
  cost_usd_total pg_catalog.numeric,
  input_tokens_total pg_catalog.int8,
  output_tokens_total pg_catalog.int8,
  cached_tokens_total pg_catalog.int8,
  zero_cost_count pg_catalog.int8,
  zero_cost_input_tokens pg_catalog.int8,
  zero_cost_output_tokens pg_catalog.int8,
  zero_cost_cached_tokens pg_catalog.int8,
  latency_p50_ms pg_catalog.float8,
  latency_p95_ms pg_catalog.float8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if in_endpoint is not null and in_project is not null then
    raise exception 'endpoint and Project filters are mutually exclusive'
      using errcode = '22023';
  end if;
  return query
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where requests.status = 'error'),
         pg_catalog.count(*) filter (where requests.cost_usd is null),
         pg_catalog.sum(requests.cost_usd),
         coalesce(pg_catalog.sum(requests.input_tokens), 0)::pg_catalog.int8,
         coalesce(pg_catalog.sum(requests.output_tokens), 0)::pg_catalog.int8,
         coalesce(pg_catalog.sum(requests.cached_tokens), 0)::pg_catalog.int8,
         pg_catalog.count(*) filter (where requests.cost_usd = 0),
         coalesce(pg_catalog.sum(requests.input_tokens)
           filter (where requests.cost_usd = 0), 0)::pg_catalog.int8,
         coalesce(pg_catalog.sum(requests.output_tokens)
           filter (where requests.cost_usd = 0), 0)::pg_catalog.int8,
         coalesce(pg_catalog.sum(requests.cached_tokens)
           filter (where requests.cost_usd = 0), 0)::pg_catalog.int8,
         pg_catalog.percentile_cont(0.5) within group (
           order by requests.latency_ms
         ),
         pg_catalog.percentile_cont(0.95) within group (
           order by requests.latency_ms
         )
  from public.serving_requests as requests
  where requests.org_id = in_org
    and (in_endpoint is null or requests.endpoint_id = in_endpoint)
    and (in_project is null or requests.optimizer_project_id = in_project)
    and (in_after is null or requests.created_at >= in_after)
    and (in_before is null or requests.created_at < in_before);
end;
$$;

revoke all on function public.serving_request_stats(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid,
  pg_catalog.timestamptz, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.serving_request_stats(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid,
  pg_catalog.timestamptz, pg_catalog.timestamptz
) to service_role;

drop function public.list_serving_request_buckets(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.timestamptz,
  pg_catalog.timestamptz, pg_catalog.int4
);

create function public.list_serving_request_buckets(
  in_org pg_catalog.uuid,
  in_endpoint pg_catalog.uuid default null,
  in_project pg_catalog.uuid default null,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_bucket_seconds pg_catalog.int4 default 86400
)
returns table (
  bucket_start pg_catalog.timestamptz,
  request_count pg_catalog.int8,
  error_count pg_catalog.int8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  step pg_catalog.int4 := greatest(coalesce(in_bucket_seconds, 86400), 60);
begin
  if in_endpoint is not null and in_project is not null then
    raise exception 'endpoint and Project filters are mutually exclusive'
      using errcode = '22023';
  end if;
  return query
  select pg_catalog.to_timestamp(
           pg_catalog.floor(extract(epoch from requests.created_at) / step) * step
         ),
         pg_catalog.count(*),
         pg_catalog.count(*) filter (where requests.status = 'error')
  from public.serving_requests as requests
  where requests.org_id = in_org
    and (in_endpoint is null or requests.endpoint_id = in_endpoint)
    and (in_project is null or requests.optimizer_project_id = in_project)
    and (in_after is null or requests.created_at >= in_after)
    and (in_before is null or requests.created_at < in_before)
  group by 1
  order by 1;
end;
$$;

revoke all on function public.list_serving_request_buckets(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid,
  pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.list_serving_request_buckets(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid,
  pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.int4
) to service_role;

revoke all on function public.finish_optimizer_project_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.finish_optimizer_project_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) to service_role;
revoke all on function public.finish_optimizer_project_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated, service_role;
drop function public.finish_optimizer_project_job(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.text
);

-- Every new operation now has an explicit provider-free preparation or paid
-- optimization input. Remove the pre-PR9 inputless enqueue path so service
-- callers cannot create an operation that the terminal invariants reject.
revoke all on function public.enqueue_optimizer_project_job(pg_catalog.uuid)
  from public, anon, authenticated, service_role;
drop function public.enqueue_optimizer_project_job(pg_catalog.uuid);
