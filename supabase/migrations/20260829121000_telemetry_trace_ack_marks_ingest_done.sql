-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Signed-upload receipts stay status=running until the claim-fenced worker
-- ack. Replace ack_trace_clickhouse_projection so router-free telemetry
-- ingests become status=done on successful projection without touching
-- project ingests (world_model_id set) or already-terminal remote receipts.
-- CREATE OR REPLACE is safe on schemas that already applied the August 22
-- queue migration or the earlier signed-upload migration.

create or replace function public.ack_trace_clickhouse_projection(
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
  set status = case
        when ingests.world_model_id is null
         and ingests.status in ('pending', 'running')
        then 'done'
        else ingests.status
      end,
      trace_projection_status = 'done',
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
