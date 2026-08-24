-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Durable one-object-per-job delivery from immutable trace bytes in Storage
-- to the normalized ClickHouse trace read model. Postgres owns only receipt,
-- workflow, and projection state; it never receives the high-cardinality span
-- payload. Claim and acknowledgement are fenced so any number of Project
-- worker replicas can drain the queue without duplicate ownership.

alter table public.trace_ingests
  add column object_sha256 pg_catalog.text,
  add column byte_size pg_catalog.int8,
  add column trace_projection_status pg_catalog.text,
  add column trace_projection_version pg_catalog.int2,
  add column trace_projected_rows pg_catalog.int8,
  add column trace_projected_at pg_catalog.timestamptz,
  add column trace_projection_error_code pg_catalog.text;

alter table public.trace_ingests
  add constraint trace_ingests_object_sha256_check
    check (object_sha256 is null or object_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint trace_ingests_byte_size_check
    check (byte_size is null or byte_size > 0),
  add constraint trace_ingests_projection_status_check
    check (
      trace_projection_status is null
      or trace_projection_status in ('pending', 'running', 'done', 'error')
    ),
  add constraint trace_ingests_projection_version_check
    check (trace_projection_version is null or trace_projection_version > 0),
  add constraint trace_ingests_projected_rows_check
    check (trace_projected_rows is null or trace_projected_rows >= 0);

create table public.trace_clickhouse_projections (
  ingest_id pg_catalog.uuid primary key
    references public.trace_ingests(id) on delete cascade,
  org_id pg_catalog.uuid not null
    references public.organizations(id) on delete cascade,
  projection_version pg_catalog.int2 not null default 1
    check (projection_version > 0),
  state pg_catalog.text not null default 'pending'
    check (state in ('pending', 'running')),
  attempts pg_catalog.int4 not null default 0 check (attempts >= 0),
  available_at pg_catalog.timestamptz not null
    default pg_catalog.clock_timestamp(),
  claimed_by pg_catalog.text,
  claim_token pg_catalog.uuid,
  claimed_until pg_catalog.timestamptz,
  last_error_code pg_catalog.text,
  created_at pg_catalog.timestamptz not null
    default pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz not null
    default pg_catalog.clock_timestamp(),
  check (
    (state = 'pending' and claimed_by is null and claim_token is null and claimed_until is null)
    or
    (state = 'running' and claimed_by is not null and claim_token is not null and claimed_until is not null)
  )
);

create index trace_clickhouse_projections_pending_idx
  on public.trace_clickhouse_projections (available_at, created_at, ingest_id)
  where state = 'pending';

create index trace_clickhouse_projections_expired_idx
  on public.trace_clickhouse_projections (claimed_until, created_at, ingest_id)
  where state = 'running';

comment on table public.trace_clickhouse_projections is
  'One durable ClickHouse projection job per immutable trace object. Span payloads remain in Storage and ClickHouse, never this queue.';

alter table public.trace_clickhouse_projections enable row level security;
revoke all on table public.trace_clickhouse_projections
  from public, anon, authenticated, service_role;

-- Complete the low-cardinality receipt and enqueue its analytical projection
-- in one short Postgres transaction. Storage upload happens before this call;
-- ClickHouse I/O happens later in a worker and can never affect API latency.
create function public.complete_telemetry_trace_ingest(
  in_ingest_id pg_catalog.uuid,
  in_result_path pg_catalog.text,
  in_trace_count pg_catalog.int4,
  in_byte_size pg_catalog.int8,
  in_object_sha256 pg_catalog.text,
  in_projection_version pg_catalog.int2 default 1
)
returns setof public.trace_ingests
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_path pg_catalog.text := nullif(pg_catalog.btrim(in_result_path), '');
  normalized_sha pg_catalog.text := pg_catalog.lower(pg_catalog.btrim(in_object_sha256));
  updated public.trace_ingests;
begin
  if normalized_path is null
     or in_trace_count < 0
     or in_byte_size <= 0
     or normalized_sha !~ '^[0-9a-f]{64}$'
     or in_projection_version <= 0 then
    raise exception using errcode = '22023',
      message = 'invalid telemetry trace completion metadata';
  end if;

  update public.trace_ingests ingests
  set status = 'done',
      result_path = normalized_path,
      trace_count = in_trace_count,
      step_count = 0,
      trace_upload_id = null,
      object_sha256 = normalized_sha,
      byte_size = in_byte_size,
      trace_projection_status = 'pending',
      trace_projection_version = in_projection_version,
      trace_projected_rows = null,
      trace_projected_at = null,
      trace_projection_error_code = null,
      updated_at = pg_catalog.clock_timestamp()
  where ingests.id = in_ingest_id
    and ingests.world_model_id is null
    and ingests.upload_path = normalized_path
    and ingests.status in ('pending', 'done')
  returning ingests.* into updated;

  if updated.id is null then
    raise exception using errcode = 'P0002',
      message = 'router-free telemetry trace ingest not found';
  end if;

  insert into public.trace_clickhouse_projections (
    ingest_id, org_id, projection_version
  ) values (
    updated.id, updated.org_id, in_projection_version
  )
  on conflict (ingest_id) do update
  set projection_version = excluded.projection_version,
      state = 'pending',
      available_at = pg_catalog.clock_timestamp(),
      claimed_by = null,
      claim_token = null,
      claimed_until = null,
      last_error_code = null,
      updated_at = pg_catalog.clock_timestamp();

  return next updated;
end;
$$;

revoke all on function public.complete_telemetry_trace_ingest(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int4, pg_catalog.int8,
  pg_catalog.text, pg_catalog.int2
) from public, anon, authenticated;
grant execute on function public.complete_telemetry_trace_ingest(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.int4, pg_catalog.int8,
  pg_catalog.text, pg_catalog.int2
) to service_role;

create function public.claim_trace_clickhouse_projection(
  in_worker_id pg_catalog.text,
  in_limit pg_catalog.int4 default 1,
  in_lease_seconds pg_catalog.int4 default 120
)
returns table (
  ingest_id pg_catalog.uuid,
  org_id pg_catalog.uuid,
  result_path pg_catalog.text,
  object_sha256 pg_catalog.text,
  byte_size pg_catalog.int8,
  source pg_catalog.jsonb,
  received_at pg_catalog.timestamptz,
  projection_version pg_catalog.int2,
  projection_attempt pg_catalog.int4,
  claim_token pg_catalog.uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(
    greatest(coalesce(in_limit, 1), 1),
    16
  );
  lease_seconds pg_catalog.int4 := least(
    greatest(coalesce(in_lease_seconds, 120), 30),
    900
  );
begin
  if in_worker_id is null
     or pg_catalog.char_length(in_worker_id) not between 1 and 128
     or in_worker_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023',
      message = 'invalid trace projection worker id';
  end if;

  return query
  with candidates as (
    select queued.ingest_id
    from public.trace_clickhouse_projections queued
    where (
      queued.state = 'pending'
      and queued.available_at <= pg_catalog.clock_timestamp()
    ) or (
      queued.state = 'running'
      and queued.claimed_until <= pg_catalog.clock_timestamp()
    )
    order by queued.created_at, queued.ingest_id
    for update skip locked
    limit cap
  ), claimed as (
    update public.trace_clickhouse_projections queued
    set state = 'running',
        attempts = queued.attempts + 1,
        claimed_by = in_worker_id,
        claim_token = pg_catalog.gen_random_uuid(),
        claimed_until = pg_catalog.clock_timestamp()
          + pg_catalog.make_interval(secs => lease_seconds),
        updated_at = pg_catalog.clock_timestamp()
    from candidates
    where queued.ingest_id = candidates.ingest_id
    returning queued.*
  ), marked as (
    update public.trace_ingests ingests
    set trace_projection_status = 'running',
        trace_projection_error_code = null,
        updated_at = pg_catalog.clock_timestamp()
    from claimed
    where ingests.id = claimed.ingest_id
    returning ingests.*
  )
  select marked.id,
         marked.org_id,
         marked.result_path,
         marked.object_sha256,
         marked.byte_size,
         marked.source,
         marked.created_at,
         claimed.projection_version,
         claimed.attempts,
         claimed.claim_token
  from claimed
  join marked on marked.id = claimed.ingest_id;
end;
$$;

revoke all on function public.claim_trace_clickhouse_projection(
  pg_catalog.text, pg_catalog.int4, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.claim_trace_clickhouse_projection(
  pg_catalog.text, pg_catalog.int4, pg_catalog.int4
) to service_role;

create function public.ack_trace_clickhouse_projection(
  in_ingest_id pg_catalog.uuid,
  in_claim_token pg_catalog.uuid,
  in_projected_rows pg_catalog.int8
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  acknowledged pg_catalog.bool := false;
begin
  if in_projected_rows < 0 then
    raise exception using errcode = '22023', message = 'invalid projected row count';
  end if;

  with owned as (
    delete from public.trace_clickhouse_projections queued
    where queued.ingest_id = in_ingest_id
      and queued.state = 'running'
      and queued.claim_token = in_claim_token
    returning queued.ingest_id, queued.projection_version
  )
  update public.trace_ingests ingests
  set trace_projection_status = 'done',
      trace_projection_version = owned.projection_version,
      trace_projected_rows = in_projected_rows,
      trace_projected_at = pg_catalog.clock_timestamp(),
      trace_projection_error_code = null,
      updated_at = pg_catalog.clock_timestamp()
  from owned
  where ingests.id = owned.ingest_id
  returning true into acknowledged;

  return coalesce(acknowledged, false);
end;
$$;

revoke all on function public.ack_trace_clickhouse_projection(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.ack_trace_clickhouse_projection(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.int8
) to service_role;

create function public.nack_trace_clickhouse_projection(
  in_ingest_id pg_catalog.uuid,
  in_claim_token pg_catalog.uuid,
  in_retry_seconds pg_catalog.int4 default 10,
  in_error_code pg_catalog.text default 'projection_failed'
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  retry_seconds pg_catalog.int4 := least(
    greatest(coalesce(in_retry_seconds, 10), 1),
    3600
  );
  normalized_error pg_catalog.text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(in_error_code), ''), 'projection_failed'),
    128
  );
  released pg_catalog.bool := false;
begin
  with owned as (
    update public.trace_clickhouse_projections queued
    set state = 'pending',
        available_at = pg_catalog.clock_timestamp()
          + pg_catalog.make_interval(secs => retry_seconds),
        claimed_by = null,
        claim_token = null,
        claimed_until = null,
        last_error_code = normalized_error,
        updated_at = pg_catalog.clock_timestamp()
    where queued.ingest_id = in_ingest_id
      and queued.state = 'running'
      and queued.claim_token = in_claim_token
    returning queued.ingest_id
  )
  update public.trace_ingests ingests
  set trace_projection_status = 'error',
      trace_projection_error_code = normalized_error,
      updated_at = pg_catalog.clock_timestamp()
  from owned
  where ingests.id = owned.ingest_id
  returning true into released;

  return coalesce(released, false);
end;
$$;

revoke all on function public.nack_trace_clickhouse_projection(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.int4, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.nack_trace_clickhouse_projection(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.int4, pg_catalog.text
) to service_role;

-- Re-enqueue receipts from an interrupted deployment without scanning or
-- copying any span payload through Postgres.
create function public.enqueue_trace_clickhouse_backfill(
  in_limit pg_catalog.int4 default 1000,
  in_projection_version pg_catalog.int2 default 1
)
returns pg_catalog.int4
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count pg_catalog.int4;
  cap pg_catalog.int4 := least(
    greatest(coalesce(in_limit, 1000), 1),
    10000
  );
begin
  if in_projection_version <= 0 then
    raise exception using errcode = '22023', message = 'invalid projection version';
  end if;

  with candidates as (
    select ingests.id, ingests.org_id
    from public.trace_ingests ingests
    left join public.trace_clickhouse_projections queued
      on queued.ingest_id = ingests.id
    where ingests.world_model_id is null
      and ingests.status = 'done'
      and ingests.result_path is not null
      and ingests.object_sha256 is not null
      and queued.ingest_id is null
      and (
        ingests.trace_projection_status is distinct from 'done'
        or ingests.trace_projection_version is distinct from in_projection_version
      )
    order by ingests.created_at, ingests.id
    limit cap
  )
  insert into public.trace_clickhouse_projections (
    ingest_id, org_id, projection_version
  )
  select candidates.id, candidates.org_id, in_projection_version
  from candidates
  on conflict (ingest_id) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.enqueue_trace_clickhouse_backfill(
  pg_catalog.int4, pg_catalog.int2
) from public, anon, authenticated;
grant execute on function public.enqueue_trace_clickhouse_backfill(
  pg_catalog.int4, pg_catalog.int2
) to service_role;

-- Deletion outbox deliberately has no foreign key: it must survive the
-- trace_ingests and organizations cascades that enqueue it. ClickHouse erasure
-- is fenced and acknowledged independently before this row disappears.
create table public.trace_clickhouse_deletions (
  ingest_id pg_catalog.uuid primary key,
  org_id pg_catalog.uuid not null,
  state pg_catalog.text not null default 'pending'
    check (state in ('pending', 'running')),
  attempts pg_catalog.int4 not null default 0 check (attempts >= 0),
  available_at pg_catalog.timestamptz not null
    default pg_catalog.clock_timestamp(),
  claimed_by pg_catalog.text,
  claim_token pg_catalog.uuid,
  claimed_until pg_catalog.timestamptz,
  last_error_code pg_catalog.text,
  created_at pg_catalog.timestamptz not null
    default pg_catalog.clock_timestamp(),
  updated_at pg_catalog.timestamptz not null
    default pg_catalog.clock_timestamp(),
  check (
    (state = 'pending' and claimed_by is null and claim_token is null and claimed_until is null)
    or
    (state = 'running' and claimed_by is not null and claim_token is not null and claimed_until is not null)
  )
);

create index trace_clickhouse_deletions_pending_idx
  on public.trace_clickhouse_deletions (available_at, created_at, ingest_id)
  where state = 'pending';

create index trace_clickhouse_deletions_expired_idx
  on public.trace_clickhouse_deletions (claimed_until, created_at, ingest_id)
  where state = 'running';

alter table public.trace_clickhouse_deletions enable row level security;
revoke all on table public.trace_clickhouse_deletions
  from public, anon, authenticated, service_role;

create function public.enqueue_trace_clickhouse_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.world_model_id is null and old.trace_projection_status is not null then
    insert into public.trace_clickhouse_deletions (ingest_id, org_id)
    values (old.id, old.org_id)
    on conflict (ingest_id) do nothing;
  end if;
  return old;
end;
$$;

revoke all on function public.enqueue_trace_clickhouse_deletion()
  from public, anon, authenticated, service_role;

create trigger trace_ingests_enqueue_clickhouse_deletion
before delete on public.trace_ingests
for each row execute function public.enqueue_trace_clickhouse_deletion();

create function public.claim_trace_clickhouse_deletion(
  in_worker_id pg_catalog.text,
  in_limit pg_catalog.int4 default 16,
  in_lease_seconds pg_catalog.int4 default 120
)
returns table (
  ingest_id pg_catalog.uuid,
  org_id pg_catalog.uuid,
  claim_token pg_catalog.uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(
    greatest(coalesce(in_limit, 16), 1),
    100
  );
  lease_seconds pg_catalog.int4 := least(
    greatest(coalesce(in_lease_seconds, 120), 30),
    900
  );
begin
  if in_worker_id is null
     or pg_catalog.char_length(in_worker_id) not between 1 and 128
     or in_worker_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023',
      message = 'invalid trace deletion worker id';
  end if;

  return query
  with candidates as (
    select queued.ingest_id
    from public.trace_clickhouse_deletions queued
    where (
      queued.state = 'pending'
      and queued.available_at <= pg_catalog.clock_timestamp()
    ) or (
      queued.state = 'running'
      and queued.claimed_until <= pg_catalog.clock_timestamp()
    )
    order by queued.created_at, queued.ingest_id
    for update skip locked
    limit cap
  )
  update public.trace_clickhouse_deletions queued
  set state = 'running',
      attempts = queued.attempts + 1,
      claimed_by = in_worker_id,
      claim_token = pg_catalog.gen_random_uuid(),
      claimed_until = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => lease_seconds),
      updated_at = pg_catalog.clock_timestamp()
  from candidates
  where queued.ingest_id = candidates.ingest_id
  returning queued.ingest_id, queued.org_id, queued.claim_token;
end;
$$;

revoke all on function public.claim_trace_clickhouse_deletion(
  pg_catalog.text, pg_catalog.int4, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.claim_trace_clickhouse_deletion(
  pg_catalog.text, pg_catalog.int4, pg_catalog.int4
) to service_role;

create function public.ack_trace_clickhouse_deletion(
  in_ingest_id pg_catalog.uuid,
  in_claim_token pg_catalog.uuid
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted pg_catalog.bool := false;
begin
  delete from public.trace_clickhouse_deletions queued
  where queued.ingest_id = in_ingest_id
    and queued.state = 'running'
    and queued.claim_token = in_claim_token
  returning true into deleted;
  return coalesce(deleted, false);
end;
$$;

revoke all on function public.ack_trace_clickhouse_deletion(
  pg_catalog.uuid, pg_catalog.uuid
) from public, anon, authenticated;
grant execute on function public.ack_trace_clickhouse_deletion(
  pg_catalog.uuid, pg_catalog.uuid
) to service_role;

create function public.nack_trace_clickhouse_deletion(
  in_ingest_id pg_catalog.uuid,
  in_claim_token pg_catalog.uuid,
  in_retry_seconds pg_catalog.int4 default 10,
  in_error_code pg_catalog.text default 'deletion_failed'
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  retry_seconds pg_catalog.int4 := least(
    greatest(coalesce(in_retry_seconds, 10), 1),
    3600
  );
  released pg_catalog.bool := false;
begin
  update public.trace_clickhouse_deletions queued
  set state = 'pending',
      available_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => retry_seconds),
      claimed_by = null,
      claim_token = null,
      claimed_until = null,
      last_error_code = pg_catalog.left(
        coalesce(nullif(pg_catalog.btrim(in_error_code), ''), 'deletion_failed'),
        128
      ),
      updated_at = pg_catalog.clock_timestamp()
  where queued.ingest_id = in_ingest_id
    and queued.state = 'running'
    and queued.claim_token = in_claim_token
  returning true into released;
  return coalesce(released, false);
end;
$$;

revoke all on function public.nack_trace_clickhouse_deletion(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.int4, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.nack_trace_clickhouse_deletion(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.int4, pg_catalog.text
) to service_role;
