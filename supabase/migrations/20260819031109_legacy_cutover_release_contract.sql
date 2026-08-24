-- Split the legacy cutover into an additive preparation transaction and a
-- separately approved seal transaction.  Routine application deploys are
-- verify-only and require every canonical release identifier below.
--
-- Replay note: this file was briefly deleted on the consolidation branch and
-- restored after 20260819100000 (which drops seal_legacy_serving_snapshot)
-- had already been applied to hosted preview-branch bases.  Replaying it on
-- such a base failed at the seal revoke ("function does not exist"), so that
-- one statement is guarded on the function's existence.  On the clean
-- in-order chain the function exists at this point and the revoke executes
-- exactly as before; when it is already gone, the revoke's intent (hosted
-- service credentials cannot call it) holds trivially.

alter table public.legacy_serving_snapshots
  add column prepared_at timestamptz,
  add column release_sha text
    check (release_sha ~ '^[0-9a-f]{40}$'),
  add column manifest_sha256 text
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  add column manifest_entry_count bigint
    check (manifest_entry_count between 1 and 4096),
  add column review_reference text
    check (char_length(review_reference) between 8 and 256),
  add column backup_evidence_sha256 text
    check (backup_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  add column d004_evidence_sha256 text
    check (d004_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  add column d004_approval_reference text
    check (char_length(d004_approval_reference) between 8 and 256),
  add column storage_inventory_sha256 text
    check (storage_inventory_sha256 ~ '^[0-9a-f]{64}$');

alter table public.legacy_serving_snapshots
  add constraint legacy_serving_snapshot_preparation_shape check (
    (
      prepared_at is null
      and release_sha is null
      and manifest_sha256 is null
      and manifest_entry_count is null
      and review_reference is null
      and backup_evidence_sha256 is null
      and d004_evidence_sha256 is null
      and d004_approval_reference is null
      and storage_inventory_sha256 is null
    )
    or (
      prepared_at is not null
      and release_sha is not null
      and manifest_sha256 is not null
      and manifest_entry_count is not null
      and review_reference is not null
      and backup_evidence_sha256 is not null
      and d004_evidence_sha256 is not null
      and d004_approval_reference is not null
      and storage_inventory_sha256 is not null
    )
  );

comment on column public.legacy_serving_snapshots.manifest_sha256 is
  'Canonical SHA-256 of the reviewer-pinned release manifest, including every runtime fingerprint.';
comment on column public.legacy_serving_snapshots.release_sha is
  'Reviewed full Git commit SHA shared by prepare, seal, and application deploy.';
comment on column public.legacy_serving_snapshots.backup_evidence_sha256 is
  'Canonical SHA-256 of database and Storage-byte backup plus restore-drill evidence.';
comment on column public.legacy_serving_snapshots.d004_evidence_sha256 is
  'Canonical SHA-256 of the accepted D-004 per-family inventory, treatment, and recovery evidence.';
comment on column public.legacy_serving_snapshots.storage_inventory_sha256 is
  'Canonical SHA-256 of exact Storage bucket, path, byte-count, and digest metadata verified before prepare and seal.';

-- The PR9 combined mutation stays available only to migration owners so old
-- schema tests and an emergency psql operator can diagnose it.  Hosted service
-- credentials cannot use it; all supported releases use the split functions.
do $$
begin
  if to_regprocedure('public.seal_legacy_serving_snapshot(text, jsonb)') is not null then
    revoke execute on function public.seal_legacy_serving_snapshot(text, jsonb)
      from service_role;
  end if;
end;
$$;

create function public.get_legacy_endpoint_release_objects(in_endpoint uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when endpoints.policy_bank_path is null then '[]'::jsonb
    else pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'bucket', 'explabs-artifacts',
        'path', endpoints.policy_bank_path,
        'sha256', endpoints.policy_bank_sha256,
        'size_bytes', endpoints.policy_bank_bytes
      )
    )
  end
  from public.endpoints endpoints
  where endpoints.id = in_endpoint;
$$;

revoke all on function public.get_legacy_endpoint_release_objects(uuid)
  from public, anon, authenticated;
grant execute on function public.get_legacy_endpoint_release_objects(uuid)
  to service_role;

create function public.prepare_legacy_serving_snapshot(
  in_release_sha text,
  in_manifest_sha256 text,
  in_manifest_entry_count bigint,
  in_review_reference text,
  in_backup_evidence_sha256 text,
  in_d004_evidence_sha256 text,
  in_d004_approval_reference text,
  in_storage_inventory_sha256 text,
  in_eligibility jsonb
)
returns public.legacy_serving_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot public.legacy_serving_snapshots%rowtype;
  candidate jsonb;
  consumer_id uuid;
  candidate_endpoint_id uuid;
  candidate_fingerprint text;
  candidate_summary jsonb;
  endpoint_row public.endpoints%rowtype;
begin
  if in_release_sha is null
     or in_release_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'legacy release SHA must contain 40 lowercase hex characters';
  end if;
  if in_manifest_sha256 is null
     or in_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'legacy manifest digest must contain 64 lowercase hex characters';
  end if;
  if in_backup_evidence_sha256 is null
     or in_backup_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'legacy backup evidence digest must contain 64 lowercase hex characters';
  end if;
  if in_d004_evidence_sha256 is null
     or in_d004_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'D-004 evidence digest must contain 64 lowercase hex characters';
  end if;
  if in_d004_approval_reference is null
     or pg_catalog.char_length(in_d004_approval_reference) not between 8 and 256 then
    raise exception 'D-004 approval reference must contain 8 to 256 characters';
  end if;
  if in_storage_inventory_sha256 is null
     or in_storage_inventory_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'legacy Storage inventory digest must contain 64 lowercase hex characters';
  end if;
  if in_review_reference is null
     or pg_catalog.char_length(in_review_reference) not between 8 and 256 then
    raise exception 'legacy review reference must contain 8 to 256 characters';
  end if;
  if pg_catalog.jsonb_typeof(in_eligibility) <> 'array'
     or pg_catalog.jsonb_array_length(in_eligibility) <> in_manifest_entry_count
     or in_manifest_entry_count not between 1 and 4096 then
    raise exception 'legacy manifest entry count does not match a bounded eligibility array';
  end if;

  select snapshots.*
    into snapshot
    from public.legacy_serving_snapshots snapshots
   where snapshots.snapshot_key = 'legacy-v1'
   for update;
  if not found then
    raise exception 'legacy-v1 snapshot provenance is missing';
  end if;
  if snapshot.sealed_at is not null then
    raise exception 'legacy serving snapshot is sealed';
  end if;
  if snapshot.prepared_at is not null
     or exists (
       select 1
         from public.legacy_serving_eligibility eligibility
        where eligibility.snapshot_key = snapshot.snapshot_key
     ) then
    raise exception 'legacy serving snapshot is already prepared';
  end if;

  for candidate in
    select value
      from pg_catalog.jsonb_array_elements(in_eligibility)
  loop
    if pg_catalog.jsonb_typeof(candidate) <> 'object'
       or candidate - array[
         'consumer_org_id',
         'endpoint_id',
         'runtime_fingerprint',
         'public_summary'
       ]::text[] <> '{}'::jsonb then
      raise exception 'legacy eligibility entry has an unsupported shape';
    end if;
    consumer_id := (candidate->>'consumer_org_id')::uuid;
    candidate_endpoint_id := (candidate->>'endpoint_id')::uuid;
    candidate_fingerprint := candidate->>'runtime_fingerprint';
    candidate_summary := coalesce(
      nullif(candidate->'public_summary', 'null'::jsonb),
      '{}'::jsonb
    );

    perform 1
      from public.organizations organizations
     where organizations.id = consumer_id
     for key share;
    if not found then
      raise exception 'legacy consumer organization not found: %', consumer_id;
    end if;

    select endpoints.*
      into endpoint_row
      from public.endpoints endpoints
     where endpoints.id = candidate_endpoint_id
     for update;
    if not found then
      raise exception 'legacy endpoint not found: %', candidate_endpoint_id;
    end if;
    if endpoint_row.status <> 'ready' then
      raise exception 'legacy endpoint is not serving-ready: %', candidate_endpoint_id;
    end if;
    if endpoint_row.org_id <> consumer_id and not endpoint_row.is_catalog_default then
      raise exception 'legacy endpoint is not owned or published for consumer: %',
        candidate_endpoint_id;
    end if;
    if candidate_fingerprint is distinct from
       public.legacy_endpoint_runtime_fingerprint(candidate_endpoint_id) then
      raise exception 'legacy runtime fingerprint mismatch: %', candidate_endpoint_id;
    end if;

    insert into public.legacy_serving_eligibility (
      snapshot_key,
      consumer_org_id,
      endpoint_id,
      endpoint_owner_org_id,
      endpoint_name,
      runtime_fingerprint,
      public_summary
    ) values (
      snapshot.snapshot_key,
      consumer_id,
      endpoint_row.id,
      endpoint_row.org_id,
      endpoint_row.name,
      candidate_fingerprint,
      candidate_summary
    );
  end loop;

  update public.legacy_serving_snapshots
     set prepared_at = pg_catalog.statement_timestamp(),
         release_sha = in_release_sha,
         manifest_sha256 = in_manifest_sha256,
         manifest_entry_count = in_manifest_entry_count,
         review_reference = in_review_reference,
         backup_evidence_sha256 = in_backup_evidence_sha256,
         d004_evidence_sha256 = in_d004_evidence_sha256,
         d004_approval_reference = in_d004_approval_reference,
         storage_inventory_sha256 = in_storage_inventory_sha256
   where snapshot_key = snapshot.snapshot_key
  returning * into snapshot;
  return snapshot;
end;
$$;

revoke all on function public.prepare_legacy_serving_snapshot(
  text, text, bigint, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.prepare_legacy_serving_snapshot(
  text, text, bigint, text, text, text, text, text, jsonb
) to service_role;

create function public.seal_prepared_legacy_serving_snapshot(
  in_image_digest text,
  in_release_sha text,
  in_manifest_sha256 text,
  in_manifest_entry_count bigint,
  in_review_reference text,
  in_backup_evidence_sha256 text,
  in_d004_evidence_sha256 text,
  in_d004_approval_reference text,
  in_storage_inventory_sha256 text
)
returns public.legacy_serving_snapshots
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot public.legacy_serving_snapshots%rowtype;
  actual_count bigint;
  seal_time timestamptz := pg_catalog.statement_timestamp();
begin
  if in_image_digest is null
     or in_image_digest !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'legacy image digest must be sha256:<64 lowercase hex characters>';
  end if;

  select snapshots.*
    into snapshot
    from public.legacy_serving_snapshots snapshots
   where snapshots.snapshot_key = 'legacy-v1'
   for update;
  if not found or snapshot.prepared_at is null then
    raise exception 'legacy serving snapshot has not been prepared';
  end if;
  if snapshot.sealed_at is not null then
    raise exception 'legacy serving snapshot is sealed';
  end if;
  if snapshot.release_sha is distinct from in_release_sha
     or snapshot.manifest_sha256 is distinct from in_manifest_sha256
     or snapshot.manifest_entry_count is distinct from in_manifest_entry_count
     or snapshot.review_reference is distinct from in_review_reference
     or snapshot.backup_evidence_sha256 is distinct from in_backup_evidence_sha256
     or snapshot.d004_evidence_sha256 is distinct from in_d004_evidence_sha256
     or snapshot.d004_approval_reference is distinct from in_d004_approval_reference
     or snapshot.storage_inventory_sha256 is distinct from in_storage_inventory_sha256 then
    raise exception 'legacy seal approval does not match prepared release metadata';
  end if;

  select pg_catalog.count(*)
    into actual_count
    from public.legacy_serving_eligibility eligibility
   where eligibility.snapshot_key = snapshot.snapshot_key;
  if actual_count <> snapshot.manifest_entry_count then
    raise exception 'legacy prepared eligibility count drifted';
  end if;
  if exists (
    select 1
      from public.legacy_serving_eligibility eligibility
     where eligibility.snapshot_key = snapshot.snapshot_key
       and public.legacy_endpoint_runtime_fingerprint(eligibility.endpoint_id)
         is distinct from eligibility.runtime_fingerprint
  ) then
    raise exception 'legacy prepared runtime fingerprint drifted before seal';
  end if;

  update public.legacy_serving_snapshots
     set legacy_image_digest = in_image_digest,
         sealed_at = seal_time,
         support_sunset_at = seal_time + interval '30 days'
   where snapshot_key = snapshot.snapshot_key
  returning * into snapshot;
  return snapshot;
end;
$$;

revoke all on function public.seal_prepared_legacy_serving_snapshot(
  text, text, text, bigint, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.seal_prepared_legacy_serving_snapshot(
  text, text, text, bigint, text, text, text, text, text
) to service_role;

drop function public.get_legacy_serving_snapshot_provenance();
create function public.get_legacy_serving_snapshot_provenance()
returns table (
  snapshot_key text,
  platform_revision text,
  wmo_revision text,
  legacy_image_digest text,
  prepared_at timestamptz,
  release_sha text,
  sealed_at timestamptz,
  support_sunset_at timestamptz,
  manifest_sha256 text,
  manifest_entry_count bigint,
  review_reference text,
  backup_evidence_sha256 text,
  d004_evidence_sha256 text,
  d004_approval_reference text,
  storage_inventory_sha256 text,
  eligibility_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    snapshots.snapshot_key,
    snapshots.platform_revision,
    snapshots.wmo_revision,
    snapshots.legacy_image_digest,
    snapshots.prepared_at,
    snapshots.release_sha,
    snapshots.sealed_at,
    snapshots.support_sunset_at,
    snapshots.manifest_sha256,
    snapshots.manifest_entry_count,
    snapshots.review_reference,
    snapshots.backup_evidence_sha256,
    snapshots.d004_evidence_sha256,
    snapshots.d004_approval_reference,
    snapshots.storage_inventory_sha256,
    (
      select pg_catalog.count(*)
        from public.legacy_serving_eligibility eligibility
       where eligibility.snapshot_key = snapshots.snapshot_key
    )
    from public.legacy_serving_snapshots snapshots
   where snapshots.snapshot_key = 'legacy-v1';
$$;

revoke all on function public.get_legacy_serving_snapshot_provenance()
  from public, anon, authenticated;
grant execute on function public.get_legacy_serving_snapshot_provenance()
  to service_role;

comment on function public.prepare_legacy_serving_snapshot(
  text, text, bigint, text, text, text, text, text, jsonb
) is 'Additively stage only the exact reviewer-pinned inventory and backup evidence.';
comment on function public.seal_prepared_legacy_serving_snapshot(
  text, text, text, bigint, text, text, text, text, text
) is 'Separately seal an exact prepared release after approval metadata is repeated.';

-- Release-fault controls are intentionally ephemeral, Project-scoped, and
-- limited by a database check to preview/staging. They let release tests drive
-- real APIs, SSE, durable jobs, and serving settlement without frontend mocks.
create table public.optimizer_project_release_faults (
  project_id uuid primary key
    references public.optimizer_projects(id) on delete cascade,
  environment text not null check (environment in ('preview', 'staging')),
  scenario text not null check (scenario in (
    'missing_credentials',
    'rotated_credentials',
    'catalog_drift',
    'credit_exhausted',
    'spend_ceiling',
    'provider_failure',
    'paid_ambiguity',
    'worker_lease_death',
    'corrupt_bundle',
    'serving_restart'
  )),
  stage text check (stage is null or stage ~ '^[a-z][a-z0-9_-]{0,63}$'),
  delay_ms integer not null default 0 check (delay_ms between 0 and 300000),
  state text not null default 'armed' check (state in ('armed', 'released', 'consumed')),
  generation bigint not null default 1 check (generation > 0),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  consumed_at timestamptz,
  check ((state = 'consumed') = (consumed_at is not null))
);

create table public.optimizer_project_release_fault_events (
  id bigint generated always as identity primary key,
  project_id uuid not null
    references public.optimizer_project_release_faults(project_id) on delete cascade,
  generation bigint not null check (generation > 0),
  environment text not null check (environment in ('preview', 'staging')),
  scenario text not null check (scenario in (
    'missing_credentials',
    'rotated_credentials',
    'catalog_drift',
    'credit_exhausted',
    'spend_ceiling',
    'provider_failure',
    'paid_ambiguity',
    'worker_lease_death',
    'corrupt_bundle',
    'serving_restart'
  )),
  stage text not null check (stage ~ '^[a-z][a-z0-9_-]{0,63}$'),
  event text not null check (event ~ '^[a-z][a-z0-9_-]{0,63}$'),
  evidence jsonb not null default '{}'::jsonb check (
    pg_catalog.jsonb_typeof(evidence) = 'object'
    and pg_catalog.octet_length(evidence::text) <= 8192
  ),
  created_at timestamptz not null default pg_catalog.statement_timestamp()
);

create index optimizer_project_release_fault_events_generation
  on public.optimizer_project_release_fault_events (project_id, generation, id);

alter table public.optimizer_project_release_faults enable row level security;
alter table public.optimizer_project_release_fault_events enable row level security;
revoke all on table public.optimizer_project_release_faults
  from public, anon, authenticated, service_role;
revoke all on table public.optimizer_project_release_fault_events
  from public, anon, authenticated, service_role;

create function public.set_optimizer_project_release_fault(
  in_project_id uuid,
  in_environment text,
  in_scenario text,
  in_stage text,
  in_delay_ms integer,
  in_hold boolean
)
returns public.optimizer_project_release_faults
language plpgsql
security definer
set search_path = ''
as $$
declare
  fault public.optimizer_project_release_faults%rowtype;
begin
  if in_environment not in ('preview', 'staging') then
    raise exception 'release faults are hard-disabled outside preview and staging';
  end if;
  if in_hold is null then
    raise exception 'release fault hold must be explicit';
  end if;
  perform 1 from public.optimizer_projects where id = in_project_id for key share;
  if not found then
    raise exception 'release fault Project does not exist';
  end if;
  delete from public.optimizer_project_release_fault_events events
   where events.project_id = in_project_id;
  insert into public.optimizer_project_release_faults (
    project_id, environment, scenario, stage, delay_ms, state
  ) values (
    in_project_id,
    in_environment,
    in_scenario,
    in_stage,
    in_delay_ms,
    case when in_hold then 'armed' else 'released' end
  )
  on conflict (project_id) do update
    set environment = excluded.environment,
        scenario = excluded.scenario,
        stage = excluded.stage,
        delay_ms = excluded.delay_ms,
        state = excluded.state,
        generation = public.optimizer_project_release_faults.generation + 1,
        updated_at = pg_catalog.statement_timestamp(),
        consumed_at = null
  returning * into fault;
  return fault;
end;
$$;

create function public.record_optimizer_project_release_fault_event(
  in_project_id uuid,
  in_environment text,
  in_generation bigint,
  in_stage text,
  in_event text,
  in_evidence jsonb
)
returns setof public.optimizer_project_release_fault_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  fault public.optimizer_project_release_faults%rowtype;
begin
  if in_environment not in ('preview', 'staging')
     or in_stage is null or in_stage !~ '^[a-z][a-z0-9_-]{0,63}$'
     or in_event is null or in_event !~ '^[a-z][a-z0-9_-]{0,63}$'
     or in_evidence is null
     or pg_catalog.jsonb_typeof(in_evidence) <> 'object'
     or pg_catalog.octet_length(in_evidence::text) > 8192 then
    raise exception 'invalid release fault event evidence';
  end if;
  select faults.* into fault
    from public.optimizer_project_release_faults faults
   where faults.project_id = in_project_id
     and faults.environment = in_environment
     and faults.generation = in_generation
     and faults.state in ('released', 'consumed')
   for key share;
  if fault.project_id is null then
    raise exception 'release fault event identity is stale';
  end if;
  return query
  insert into public.optimizer_project_release_fault_events (
    project_id, generation, environment, scenario, stage, event, evidence
  ) values (
    fault.project_id,
    fault.generation,
    fault.environment,
    fault.scenario,
    in_stage,
    in_event,
    in_evidence
  ) returning *;
end;
$$;

create function public.get_optimizer_project_release_fault_events(
  in_project_id uuid,
  in_environment text,
  in_generation bigint
)
returns setof public.optimizer_project_release_fault_events
language sql
stable
security definer
set search_path = ''
as $$
  select events.*
    from public.optimizer_project_release_fault_events events
   where events.project_id = in_project_id
     and events.environment = in_environment
     and events.generation = in_generation
   order by events.id;
$$;

create function public.get_optimizer_project_release_fault(
  in_project_id uuid,
  in_environment text
)
returns setof public.optimizer_project_release_faults
language sql
stable
security definer
set search_path = ''
as $$
  select faults.*
    from public.optimizer_project_release_faults faults
   where faults.project_id = in_project_id
     and faults.environment = in_environment;
$$;

create function public.release_optimizer_project_release_fault(
  in_project_id uuid,
  in_environment text,
  in_generation bigint
)
returns setof public.optimizer_project_release_faults
language sql
security definer
set search_path = ''
as $$
  update public.optimizer_project_release_faults faults
     set state = 'released', updated_at = pg_catalog.statement_timestamp()
   where faults.project_id = in_project_id
     and faults.environment = in_environment
     and faults.generation = in_generation
     and faults.state = 'armed'
  returning faults.*;
$$;

create function public.consume_optimizer_project_release_fault(
  in_project_id uuid,
  in_environment text,
  in_generation bigint
)
returns setof public.optimizer_project_release_faults
language sql
security definer
set search_path = ''
as $$
  update public.optimizer_project_release_faults faults
     set state = 'consumed',
         consumed_at = pg_catalog.statement_timestamp(),
         updated_at = pg_catalog.statement_timestamp()
   where faults.project_id = in_project_id
     and faults.environment = in_environment
     and faults.generation = in_generation
     and faults.state = 'released'
  returning faults.*;
$$;

create function public.trigger_optimizer_project_release_reservation_gate(
  in_server_interaction_id uuid,
  in_environment text,
  in_generation bigint,
  in_components jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  interaction public.optimizer_project_serving_interactions%rowtype;
  fault public.optimizer_project_release_faults%rowtype;
  reserved_total pg_catalog.numeric(20, 6);
  settings public.optimizer_project_serving_settings%rowtype;
  organization public.organizations%rowtype;
  public_code text;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if in_environment not in ('preview', 'staging')
     or in_components is null
     or pg_catalog.jsonb_typeof(in_components) <> 'array'
     or pg_catalog.jsonb_array_length(in_components) <> 2 then
    raise exception 'invalid release reservation gate evidence';
  end if;
  select interactions.* into interaction
    from public.optimizer_project_serving_interactions interactions
   where interactions.server_interaction_id = in_server_interaction_id
     and interactions.state = 'admitted'
   for update;
  if interaction.server_interaction_id is null then
    raise exception 'release reservation gate requires one admitted interaction';
  end if;
  select faults.* into fault
    from public.optimizer_project_release_faults faults
   where faults.project_id = interaction.project_id
     and faults.environment = in_environment
     and faults.generation = in_generation
     and faults.scenario in ('credit_exhausted', 'spend_ceiling')
     and faults.state = 'released'
   for update;
  if fault.project_id is null then
    raise exception 'release reservation fault identity is stale';
  end if;
  select coalesce(pg_catalog.sum(
    (components.value ->> 'cost_usd')::pg_catalog.numeric
  ), 0) into reserved_total
  from pg_catalog.jsonb_array_elements(in_components) components(value);
  select rows.* into settings
    from public.optimizer_project_serving_settings rows
   where rows.project_id = interaction.project_id
   for key share;
  select rows.* into organization
    from public.organizations rows
   where rows.id = interaction.org_id
   for key share;
  if settings.project_id is null or organization.id is null then
    raise exception 'release reservation gate lost its durable accounting rows';
  end if;
  public_code := case fault.scenario
    when 'credit_exhausted' then 'credits_exhausted'
    else 'spend_limit_exceeded'
  end;
  update public.optimizer_project_release_faults faults
     set state = 'consumed',
         consumed_at = pg_catalog.statement_timestamp(),
         updated_at = pg_catalog.statement_timestamp()
   where faults.project_id = fault.project_id
     and faults.generation = fault.generation;
  insert into public.optimizer_project_release_fault_events (
    project_id, generation, environment, scenario, stage, event, evidence
  ) values (
    fault.project_id,
    fault.generation,
    fault.environment,
    fault.scenario,
    'reservation',
    'reservation_gate_rejected',
    pg_catalog.jsonb_build_object(
      'server_interaction_id', interaction.server_interaction_id,
      'reserved_total_usd', reserved_total,
      'organization_credit_granted_usd', organization.credit_granted_usd,
      'organization_billable_spend_usd', organization.billable_spend_usd,
      'project_spend_limit_usd', settings.monthly_spend_limit_usd,
      'public_code', public_code
    )
  );
  return public_code;
end;
$$;

create function public.consume_optimizer_project_worker_lease_fault(
  in_project_id uuid,
  in_environment text,
  in_generation bigint,
  in_job_id uuid,
  in_claim_generation bigint
)
returns setof public.optimizer_project_release_faults
language plpgsql
security definer
set search_path = ''
as $$
declare
  job public.optimizer_project_jobs%rowtype;
  fault public.optimizer_project_release_faults%rowtype;
begin
  perform public.optimizer_project_wmo_require_service_role();
  select jobs.* into job
    from public.optimizer_project_jobs jobs
   where jobs.id = in_job_id
     and jobs.project_id = in_project_id
     and jobs.claim_generation = in_claim_generation
     and jobs.status in ('claimed', 'running')
   for update;
  if job.id is null then
    raise exception 'worker lease fault lost its active claim';
  end if;
  select faults.* into fault
    from public.optimizer_project_release_faults faults
   where faults.project_id = in_project_id
     and faults.environment = in_environment
     and faults.generation = in_generation
     and faults.scenario = 'worker_lease_death'
     and faults.state = 'released'
     and (faults.stage is null or faults.stage = job.stage)
   for update;
  if fault.project_id is null then
    raise exception 'worker lease fault identity is stale';
  end if;
  update public.optimizer_project_jobs jobs
     set lease_expires_at = pg_catalog.clock_timestamp() - pg_catalog.interval '1 millisecond',
         updated_at = pg_catalog.clock_timestamp()
   where jobs.id = job.id
     and jobs.claim_generation = job.claim_generation;
  update public.optimizer_project_release_faults faults
     set state = 'consumed',
         consumed_at = pg_catalog.statement_timestamp(),
         updated_at = pg_catalog.statement_timestamp()
   where faults.project_id = fault.project_id
     and faults.generation = fault.generation
  returning * into fault;
  insert into public.optimizer_project_release_fault_events (
    project_id, generation, environment, scenario, stage, event, evidence
  ) values (
    fault.project_id,
    fault.generation,
    fault.environment,
    fault.scenario,
    coalesce(job.stage, 'claimed'),
    'worker_lease_abandoned',
    pg_catalog.jsonb_build_object(
      'job_id', job.id,
      'claim_generation', job.claim_generation,
      'attempt_count', job.attempt_count
    )
  );
  return next fault;
end;
$$;

create function public.fence_optimizer_project_release_fault_reclaim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  fault public.optimizer_project_release_faults%rowtype;
begin
  if old.status not in ('claimed', 'running')
     or new.status <> 'queued'
     or old.lease_expires_at is null
     or old.lease_expires_at > pg_catalog.clock_timestamp()
     or new.claim_generation <= old.claim_generation then
    return new;
  end if;
  select faults.* into fault
    from public.optimizer_project_release_faults faults
   where faults.project_id = old.project_id
     and faults.scenario = 'worker_lease_death'
     and faults.state = 'consumed'
   order by faults.consumed_at desc
   limit 1;
  if fault.project_id is null then
    return new;
  end if;
  new.available_at := pg_catalog.clock_timestamp() + pg_catalog.interval '5 minutes';
  insert into public.optimizer_project_release_fault_events (
    project_id, generation, environment, scenario, stage, event, evidence
  ) values (
    fault.project_id,
    fault.generation,
    fault.environment,
    fault.scenario,
    coalesce(old.stage, 'claimed'),
    'worker_lease_reclaimed',
    pg_catalog.jsonb_build_object(
      'job_id', old.id,
      'previous_claim_generation', old.claim_generation,
      'requeued_claim_generation', new.claim_generation,
      'attempt_count', old.attempt_count,
      'redispatch_blocked_until', new.available_at
    )
  );
  return new;
end;
$$;

create trigger fence_optimizer_project_release_fault_reclaim
before update on public.optimizer_project_jobs
for each row execute function public.fence_optimizer_project_release_fault_reclaim();

create function public.reset_optimizer_project_release_fault(
  in_project_id uuid,
  in_environment text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed bigint;
begin
  delete from public.optimizer_project_release_faults faults
   where faults.project_id = in_project_id
     and faults.environment = in_environment;
  get diagnostics removed = row_count;
  return removed in (0, 1);
end;
$$;

revoke all on function public.set_optimizer_project_release_fault(
  uuid, text, text, text, integer, boolean
) from public, anon, authenticated;
revoke all on function public.get_optimizer_project_release_fault(uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_optimizer_project_release_fault(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.consume_optimizer_project_release_fault(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.record_optimizer_project_release_fault_event(
  uuid, text, bigint, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.get_optimizer_project_release_fault_events(uuid, text, bigint)
  from public, anon, authenticated;
revoke all on function public.trigger_optimizer_project_release_reservation_gate(
  uuid, text, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.consume_optimizer_project_worker_lease_fault(
  uuid, text, bigint, uuid, bigint
) from public, anon, authenticated;
revoke all on function public.fence_optimizer_project_release_fault_reclaim()
  from public, anon, authenticated, service_role;
revoke all on function public.reset_optimizer_project_release_fault(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_optimizer_project_release_fault(
  uuid, text, text, text, integer, boolean
) to service_role;
grant execute on function public.get_optimizer_project_release_fault(uuid, text)
  to service_role;
grant execute on function public.release_optimizer_project_release_fault(uuid, text, bigint)
  to service_role;
grant execute on function public.consume_optimizer_project_release_fault(uuid, text, bigint)
  to service_role;
grant execute on function public.record_optimizer_project_release_fault_event(
  uuid, text, bigint, text, text, jsonb
) to service_role;
grant execute on function public.get_optimizer_project_release_fault_events(uuid, text, bigint)
  to service_role;
grant execute on function public.trigger_optimizer_project_release_reservation_gate(
  uuid, text, bigint, jsonb
) to service_role;
grant execute on function public.consume_optimizer_project_worker_lease_fault(
  uuid, text, bigint, uuid, bigint
) to service_role;
grant execute on function public.reset_optimizer_project_release_fault(uuid, text)
  to service_role;

comment on table public.optimizer_project_release_faults is
  'One-shot authenticated preview/staging release fault; production is impossible by constraint.';
comment on table public.optimizer_project_release_fault_events is
  'Redacted mechanism, accounting, and reclaim evidence for one exact release-fault generation.';
