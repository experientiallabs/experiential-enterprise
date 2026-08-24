-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Two-phase org telemetry upload: reserve a path-bound signed upload, then
-- accept by enqueueing the existing ClickHouse projection queue. The worker,
-- not the accept RPC, verifies object existence, size, format, and digest.

create index trace_ingests_abandoned_upload_idx
  on public.trace_ingests (created_at, id)
  where world_model_id is null
    and status = 'pending'
    and trace_projection_status is null;

create index trace_ingests_failed_upload_cleanup_idx
  on public.trace_ingests (updated_at, id)
  where world_model_id is null
    and status = 'error'
    and error_code in (
      'abandoned_upload',
      'object_missing',
      'object_too_large',
      'object_malformed'
    )
    and upload_path is not null;

-- Accept is a short Postgres transaction only: it never downloads bytes and
-- never talks to ClickHouse. A second call returns the current receipt.
create function public.accept_telemetry_trace_ingest(
  in_ingest_id pg_catalog.uuid
)
returns setof public.trace_ingests
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.trace_ingests;
  updated public.trace_ingests;
begin
  select ingests.*
    into current_row
  from public.trace_ingests ingests
  where ingests.id = in_ingest_id
    and ingests.world_model_id is null
  for update;

  if current_row.id is null then
    raise exception using errcode = 'P0002',
      message = 'router-free telemetry trace ingest not found';
  end if;

  if current_row.upload_path is null
     or pg_catalog.btrim(current_row.upload_path) = '' then
    raise exception using errcode = '22023',
      message = 'telemetry trace ingest is missing its reserved object path';
  end if;

  if current_row.status = 'pending' then
    update public.trace_ingests ingests
    set status = 'running',
        result_path = coalesce(ingests.result_path, ingests.upload_path),
        trace_projection_status = 'pending',
        trace_projection_version = coalesce(ingests.trace_projection_version, 1),
        trace_projection_error_code = null,
        updated_at = pg_catalog.clock_timestamp()
    where ingests.id = current_row.id
    returning ingests.* into updated;
  else
    updated := current_row;
  end if;

  if updated.status in ('pending', 'running')
     or (
       updated.status = 'done'
       and updated.trace_projection_status is distinct from 'done'
     ) then
    insert into public.trace_clickhouse_projections (
      ingest_id, org_id, projection_version
    ) values (
      updated.id,
      updated.org_id,
      coalesce(updated.trace_projection_version, 1)
    )
    on conflict (ingest_id) do nothing;
  end if;

  return next updated;
end;
$$;

revoke all on function public.accept_telemetry_trace_ingest(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.accept_telemetry_trace_ingest(pg_catalog.uuid)
  to service_role;

create function public.record_telemetry_trace_object(
  in_ingest_id pg_catalog.uuid,
  in_claim_token pg_catalog.uuid,
  in_object_sha256 pg_catalog.text,
  in_byte_size pg_catalog.int8,
  in_trace_count pg_catalog.int4
)
returns setof public.trace_ingests
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_sha pg_catalog.text := pg_catalog.lower(pg_catalog.btrim(in_object_sha256));
  updated public.trace_ingests;
begin
  if in_byte_size <= 0
     or in_trace_count < 0
     or normalized_sha !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023',
      message = 'invalid verified telemetry trace object metadata';
  end if;

  update public.trace_ingests ingests
  set object_sha256 = normalized_sha,
      byte_size = in_byte_size,
      trace_count = in_trace_count,
      result_path = coalesce(ingests.result_path, ingests.upload_path),
      updated_at = pg_catalog.clock_timestamp()
  from public.trace_clickhouse_projections queued
  where ingests.id = in_ingest_id
    and ingests.world_model_id is null
    and queued.ingest_id = ingests.id
    and queued.state = 'running'
    and queued.claim_token = in_claim_token
    and (
      ingests.object_sha256 is null
      or ingests.object_sha256 = normalized_sha
    )
    and (
      ingests.byte_size is null
      or ingests.byte_size = in_byte_size
    )
  returning ingests.* into updated;

  if updated.id is null then
    raise exception using errcode = 'P0002',
      message = 'verified telemetry trace object could not be recorded';
  end if;

  return next updated;
end;
$$;

revoke all on function public.record_telemetry_trace_object(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.record_telemetry_trace_object(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.int4
) to service_role;

create function public.fail_telemetry_trace_ingest(
  in_ingest_id pg_catalog.uuid,
  in_claim_token pg_catalog.uuid,
  in_error_code pg_catalog.text,
  in_error_message pg_catalog.text
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_error pg_catalog.text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(in_error_code), ''), 'object_malformed'),
    128
  );
  normalized_message pg_catalog.text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(in_error_message), ''), normalized_error),
    500
  );
  failed pg_catalog.bool := false;
begin
  with owned as (
    delete from public.trace_clickhouse_projections queued
    where queued.ingest_id = in_ingest_id
      and queued.state = 'running'
      and queued.claim_token = in_claim_token
    returning queued.ingest_id
  )
  update public.trace_ingests ingests
  set status = 'error',
      error_code = normalized_error,
      error_message = normalized_message,
      trace_projection_status = 'error',
      trace_projection_error_code = normalized_error,
      updated_at = pg_catalog.clock_timestamp()
  from owned
  where ingests.id = owned.ingest_id
  returning true into failed;

  return coalesce(failed, false);
end;
$$;

revoke all on function public.fail_telemetry_trace_ingest(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.fail_telemetry_trace_ingest(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text
) to service_role;

create function public.claim_abandoned_telemetry_trace_ingests(
  in_older_than_seconds pg_catalog.int4 default 7200,
  in_limit pg_catalog.int4 default 16
)
returns setof public.trace_ingests
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 16), 1), 100);
  age_seconds pg_catalog.int4 := least(
    greatest(coalesce(in_older_than_seconds, 7200), 60),
    604800
  );
begin
  return query
  with candidates as (
    select ingests.id
    from public.trace_ingests ingests
    where ingests.world_model_id is null
      and ingests.upload_path is not null
      and (
        (
          ingests.status = 'pending'
          and ingests.trace_projection_status is null
          and ingests.created_at
            <= pg_catalog.clock_timestamp()
              - pg_catalog.make_interval(secs => age_seconds)
        )
        or (
          ingests.status = 'error'
          and ingests.error_code in (
            'abandoned_upload',
            'object_missing',
            'object_too_large',
            'object_malformed'
          )
        )
      )
    order by ingests.created_at, ingests.id
    for update skip locked
    limit cap
  )
  update public.trace_ingests ingests
  set status = 'error',
      error_code = coalesce(ingests.error_code, 'abandoned_upload'),
      error_message = coalesce(ingests.error_message, 'abandoned signed upload'),
      updated_at = pg_catalog.clock_timestamp()
  from candidates
  where ingests.id = candidates.id
  returning ingests.*;
end;
$$;

revoke all on function public.claim_abandoned_telemetry_trace_ingests(
  pg_catalog.int4, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.claim_abandoned_telemetry_trace_ingests(
  pg_catalog.int4, pg_catalog.int4
) to service_role;

create function public.ack_abandoned_telemetry_trace_ingest(
  in_ingest_id pg_catalog.uuid,
  in_delete_row pg_catalog.bool default false
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  acknowledged pg_catalog.bool := false;
begin
  if in_delete_row then
    delete from public.trace_ingests ingests
    where ingests.id = in_ingest_id
      and ingests.world_model_id is null
      and ingests.status = 'error'
    returning true into acknowledged;
  else
    update public.trace_ingests ingests
    set upload_path = null,
        result_path = null,
        updated_at = pg_catalog.clock_timestamp()
    where ingests.id = in_ingest_id
      and ingests.world_model_id is null
      and ingests.status = 'error'
    returning true into acknowledged;
  end if;
  return coalesce(acknowledged, false);
end;
$$;

revoke all on function public.ack_abandoned_telemetry_trace_ingest(
  pg_catalog.uuid, pg_catalog.bool
) from public, anon, authenticated;
grant execute on function public.ack_abandoned_telemetry_trace_ingest(
  pg_catalog.uuid, pg_catalog.bool
) to service_role;
