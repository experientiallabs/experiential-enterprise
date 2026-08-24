-- Frozen legacy serving is a temporary compatibility lane. The current API
-- authorizes live credentials against this immutable tenant-and-endpoint
-- allowlist, then proxies only admitted traffic to the exact F1 image.

create unique index if not exists endpoints_id_org_id_idx
  on public.endpoints (id, org_id);

create table public.legacy_serving_snapshots (
  snapshot_key text primary key check (snapshot_key = 'legacy-v1'),
  platform_revision text not null
    check (platform_revision = '061a4846bac3ebfdf652ffc755a150814182f1f1'),
  wmo_revision text not null
    check (wmo_revision = '7ce2de04eab744ed02241611b113817d9cf7ca47'),
  legacy_image_digest text
    check (legacy_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  sealed_at timestamptz,
  support_sunset_at timestamptz,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  check (
    (sealed_at is null and legacy_image_digest is null and support_sunset_at is null)
    or (
      sealed_at is not null
      and legacy_image_digest is not null
      and support_sunset_at = sealed_at + interval '30 days'
    )
  )
);

insert into public.legacy_serving_snapshots (
  snapshot_key,
  platform_revision,
  wmo_revision
)
values (
  'legacy-v1',
  '061a4846bac3ebfdf652ffc755a150814182f1f1',
  '7ce2de04eab744ed02241611b113817d9cf7ca47'
);

create table public.legacy_serving_eligibility (
  snapshot_key text not null default 'legacy-v1'
    references public.legacy_serving_snapshots(snapshot_key) on delete restrict,
  consumer_org_id uuid not null
    references public.organizations(id) on delete cascade,
  endpoint_id uuid not null,
  endpoint_owner_org_id uuid not null,
  endpoint_name text not null check (endpoint_name ~ '^[a-z0-9][a-z0-9_-]*$'),
  runtime_fingerprint text not null
    check (runtime_fingerprint ~ '^[0-9a-f]{64}$'),
  public_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  primary key (snapshot_key, consumer_org_id, endpoint_name),
  unique (snapshot_key, consumer_org_id, endpoint_id),
  foreign key (endpoint_id, endpoint_owner_org_id)
    references public.endpoints(id, org_id) on delete cascade,
  check (pg_catalog.jsonb_typeof(public_summary) = 'object'),
  check (pg_catalog.pg_column_size(public_summary) <= 65536),
  check (
    public_summary - array[
      'headline',
      'embodies_default',
      'error',
      'policy_summary',
      'world_model',
      'served_model'
    ]::text[] = '{}'::jsonb
  )
);

create index legacy_serving_eligibility_consumer_idx
  on public.legacy_serving_eligibility (consumer_org_id);
create index legacy_serving_eligibility_endpoint_idx
  on public.legacy_serving_eligibility (endpoint_id, endpoint_owner_org_id);

alter table public.legacy_serving_snapshots enable row level security;
alter table public.legacy_serving_eligibility enable row level security;
revoke all on table public.legacy_serving_snapshots
  from public, anon, authenticated, service_role;
revoke all on table public.legacy_serving_eligibility
  from public, anon, authenticated, service_role;

comment on table public.legacy_serving_snapshots is
  'Exact immutable source and image provenance for temporary legacy /v1 serving.';
comment on table public.legacy_serving_eligibility is
  'Sealed tenant-and-endpoint allowlist; credentials and provider connections remain live.';
comment on column public.legacy_serving_eligibility.public_summary is
  'Reviewed customer-safe projection only; never raw policy or provider resource ids.';

create function public.legacy_endpoint_runtime_fingerprint(in_endpoint uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'id', endpoints.id,
          'org_id', endpoints.org_id,
          'world_model_id', endpoints.world_model_id,
          'name', endpoints.name,
          'status', endpoints.status,
          'policy', endpoints.policy,
          'report', endpoints.report,
          'is_catalog_default', endpoints.is_catalog_default,
          'policy_bank_path', endpoints.policy_bank_path,
          'policy_bank_sha256', endpoints.policy_bank_sha256,
          'policy_bank_bytes', endpoints.policy_bank_bytes,
          'reasoning_enabled', endpoints.reasoning_enabled,
          'model_params', endpoints.model_params,
          'origin', endpoints.origin,
          'created_at', endpoints.created_at
        )::text,
        'utf8'
      )
    ),
    'hex'
  )
  from public.endpoints
  where id = in_endpoint;
$$;

revoke all on function public.legacy_endpoint_runtime_fingerprint(uuid)
  from public, anon, authenticated;
grant execute on function public.legacy_endpoint_runtime_fingerprint(uuid)
  to service_role;

create function public.reject_sealed_legacy_serving_snapshot_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.sealed_at is not null then
    raise exception 'legacy serving snapshot is sealed';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.reject_sealed_legacy_serving_snapshot_write()
  from public, anon, authenticated, service_role;

create trigger legacy_serving_snapshot_immutable_after_seal
before update or delete on public.legacy_serving_snapshots
for each row execute function public.reject_sealed_legacy_serving_snapshot_write();

create function public.reject_sealed_legacy_serving_eligibility_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_snapshot text := case when tg_op = 'DELETE' then old.snapshot_key else new.snapshot_key end;
  target_sealed_at timestamptz;
begin
  select snapshots.sealed_at
    into target_sealed_at
    from public.legacy_serving_snapshots snapshots
   where snapshots.snapshot_key = target_snapshot;
  if target_sealed_at is not null
     and not (tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1) then
    raise exception 'legacy serving eligibility is sealed';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.reject_sealed_legacy_serving_eligibility_write()
  from public, anon, authenticated, service_role;

create trigger legacy_serving_eligibility_immutable_after_seal
before insert or update or delete on public.legacy_serving_eligibility
for each row execute function public.reject_sealed_legacy_serving_eligibility_write();

create function public.reject_admitted_legacy_endpoint_runtime_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  admitted boolean;
begin
  select exists (
    select 1
      from public.legacy_serving_eligibility eligibility
      join public.legacy_serving_snapshots snapshots
        on snapshots.snapshot_key = eligibility.snapshot_key
     where eligibility.endpoint_id = old.id
       and snapshots.sealed_at is not null
  ) into admitted;
  if not admitted then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'an admitted legacy endpoint cannot be deleted';
  end if;
  if (
    pg_catalog.to_jsonb(new) - array[
      'store_bodies',
      'paused',
      'spend_limit_usd',
      'token_limit',
      'spend_alert_fraction',
      'updated_at'
    ]::text[]
  ) is distinct from (
    pg_catalog.to_jsonb(old) - array[
      'store_bodies',
      'paused',
      'spend_limit_usd',
      'token_limit',
      'spend_alert_fraction',
      'updated_at'
    ]::text[]
  ) then
    raise exception 'admitted legacy endpoint runtime and identity are immutable';
  end if;
  return new;
end;
$$;

revoke all on function public.reject_admitted_legacy_endpoint_runtime_write()
  from public, anon, authenticated, service_role;

create trigger endpoints_frozen_when_admitted_to_legacy_serving
before update or delete on public.endpoints
for each row execute function public.reject_admitted_legacy_endpoint_runtime_write();

create function public.seal_legacy_serving_snapshot(
  in_image_digest text,
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
  seal_time timestamptz := pg_catalog.statement_timestamp();
begin
  if in_image_digest is null or in_image_digest !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'legacy image digest must be sha256:<64 lowercase hex characters>';
  end if;
  if pg_catalog.jsonb_typeof(in_eligibility) <> 'array' then
    raise exception 'legacy eligibility must be a JSON array';
  end if;
  if pg_catalog.jsonb_array_length(in_eligibility) > 4096 then
    raise exception 'legacy eligibility cannot exceed 4096 entries';
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
  if exists (
    select 1
      from public.legacy_serving_eligibility eligibility
     where eligibility.snapshot_key = snapshot.snapshot_key
  ) then
    raise exception 'legacy serving eligibility was already staged';
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
      raise exception 'legacy endpoint is not owned or published for consumer: %', candidate_endpoint_id;
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
    )
    values (
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
     set legacy_image_digest = in_image_digest,
         sealed_at = seal_time,
         support_sunset_at = seal_time + interval '30 days'
   where snapshot_key = snapshot.snapshot_key
  returning * into snapshot;
  return snapshot;
end;
$$;

revoke all on function public.seal_legacy_serving_snapshot(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.seal_legacy_serving_snapshot(text, jsonb)
  to service_role;

create function public.get_legacy_serving_snapshot_provenance()
returns table (
  snapshot_key text,
  platform_revision text,
  wmo_revision text,
  legacy_image_digest text,
  sealed_at timestamptz,
  support_sunset_at timestamptz,
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
    snapshots.sealed_at,
    snapshots.support_sunset_at,
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

create function public.list_legacy_serving_endpoints(in_consumer_org uuid)
returns table (
  consumer_org_id uuid,
  endpoint_id uuid,
  endpoint_owner_org_id uuid,
  endpoint_name text,
  runtime_fingerprint text,
  public_summary jsonb,
  status text,
  world_model_id uuid,
  report jsonb,
  origin text,
  is_catalog_default boolean,
  store_bodies boolean,
  paused boolean,
  spend_limit_usd numeric,
  token_limit bigint,
  spend_alert_fraction numeric,
  created_at timestamptz,
  updated_at timestamptz,
  support_sunset_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    eligibility.consumer_org_id,
    endpoints.id,
    endpoints.org_id,
    eligibility.endpoint_name,
    eligibility.runtime_fingerprint,
    eligibility.public_summary,
    endpoints.status,
    endpoints.world_model_id,
    endpoints.report,
    endpoints.origin,
    endpoints.is_catalog_default,
    endpoints.store_bodies,
    endpoints.paused,
    endpoints.spend_limit_usd,
    endpoints.token_limit,
    endpoints.spend_alert_fraction,
    endpoints.created_at,
    endpoints.updated_at,
    snapshots.support_sunset_at
    from public.legacy_serving_eligibility eligibility
    join public.legacy_serving_snapshots snapshots
      on snapshots.snapshot_key = eligibility.snapshot_key
    join public.endpoints endpoints
      on endpoints.id = eligibility.endpoint_id
     and endpoints.org_id = eligibility.endpoint_owner_org_id
   where eligibility.consumer_org_id = in_consumer_org
     and snapshots.sealed_at is not null
     and snapshots.support_sunset_at > pg_catalog.statement_timestamp()
     and public.legacy_endpoint_runtime_fingerprint(endpoints.id)
       = eligibility.runtime_fingerprint
   order by endpoints.created_at desc, eligibility.endpoint_name;
$$;

revoke all on function public.list_legacy_serving_endpoints(uuid)
  from public, anon, authenticated;
grant execute on function public.list_legacy_serving_endpoints(uuid)
  to service_role;

create function public.resolve_legacy_serving_endpoint(
  in_consumer_org uuid,
  in_endpoint_name text
)
returns table (
  consumer_org_id uuid,
  endpoint_id uuid,
  endpoint_owner_org_id uuid,
  endpoint_name text,
  runtime_fingerprint text,
  public_summary jsonb,
  status text,
  world_model_id uuid,
  report jsonb,
  origin text,
  is_catalog_default boolean,
  store_bodies boolean,
  paused boolean,
  spend_limit_usd numeric,
  token_limit bigint,
  spend_alert_fraction numeric,
  created_at timestamptz,
  updated_at timestamptz,
  support_sunset_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select listed.*
    from public.list_legacy_serving_endpoints(in_consumer_org) listed
   where listed.endpoint_name = in_endpoint_name
   limit 1;
$$;

revoke all on function public.resolve_legacy_serving_endpoint(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_legacy_serving_endpoint(uuid, text)
  to service_role;

create function public.update_legacy_endpoint_controls(
  in_consumer_org uuid,
  in_endpoint_name text,
  in_store_bodies boolean,
  in_paused boolean,
  in_spend_limit_usd numeric,
  in_token_limit bigint,
  in_spend_alert_fraction numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_endpoint uuid;
begin
  if in_store_bodies is null or in_paused is null then
    raise exception 'legacy boolean controls cannot be null';
  end if;
  if in_spend_alert_fraction is not null and in_spend_limit_usd is null then
    raise exception 'a spend alert needs a spend ceiling';
  end if;

  update public.endpoints endpoints
     set store_bodies = in_store_bodies,
         paused = in_paused,
         spend_limit_usd = in_spend_limit_usd,
         token_limit = in_token_limit,
         spend_alert_fraction = in_spend_alert_fraction,
         updated_at = pg_catalog.statement_timestamp()
    from public.legacy_serving_eligibility eligibility
    join public.legacy_serving_snapshots snapshots
      on snapshots.snapshot_key = eligibility.snapshot_key
   where eligibility.consumer_org_id = in_consumer_org
     and eligibility.endpoint_name = in_endpoint_name
     and eligibility.endpoint_id = endpoints.id
     and eligibility.endpoint_owner_org_id = endpoints.org_id
     and endpoints.org_id = in_consumer_org
     and snapshots.sealed_at is not null
     and snapshots.support_sunset_at > pg_catalog.statement_timestamp()
  returning endpoints.id into updated_endpoint;
  if updated_endpoint is null then
    raise exception 'legacy endpoint not found or read-only';
  end if;
end;
$$;

revoke all on function public.update_legacy_endpoint_controls(
  uuid, text, boolean, boolean, numeric, bigint, numeric
) from public, anon, authenticated;
grant execute on function public.update_legacy_endpoint_controls(
  uuid, text, boolean, boolean, numeric, bigint, numeric
) to service_role;

comment on function public.seal_legacy_serving_snapshot(text, jsonb) is
  'Atomically verifies and seals the reviewed endpoint set and immutable image digest.';
comment on function public.update_legacy_endpoint_controls(
  uuid, text, boolean, boolean, numeric, bigint, numeric
) is
  'The only post-seal endpoint write: exactly five customer serving controls.';
comment on trigger endpoints_frozen_when_admitted_to_legacy_serving on public.endpoints is
  'Unfreezing an admitted endpoint requires a later explicit, audited migration.';
