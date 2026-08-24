begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

insert into public.organizations (id, slug, name) values (
  '6d000000-0000-0000-0000-000000000001',
  'pgtap-trace-clickhouse',
  'pgTAP Trace ClickHouse'
);

insert into public.trace_ingests (
  id, org_id, source, status, upload_path
) values (
  '6d100000-0000-0000-0000-000000000001',
  '6d000000-0000-0000-0000-000000000001',
  '{"kind":"file","source_kind":"otlp","source_label":"prod"}'::jsonb,
  'pending',
  'orgs/6d/traces/abc'
);

select is(
  (
    select completed.status
    from public.complete_telemetry_trace_ingest(
      '6d100000-0000-0000-0000-000000000001',
      'orgs/6d/traces/abc',
      2,
      42::bigint,
      repeat('a', 64),
      1::smallint
    ) completed
  ),
  'done',
  'receipt completion succeeds without a ClickHouse call'
);

select is(
  (select object_sha256 from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  repeat('a', 64),
  'receipt stores only the immutable object digest'
);

select is(
  (select byte_size from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  42::bigint,
  'receipt stores the low-cardinality byte count'
);

select is(
  (select trace_projection_status from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  'pending',
  'completion marks analytical projection pending'
);

select is(
  (select count(*)::int from public.trace_clickhouse_projections),
  1,
  'completion creates exactly one object-level projection job'
);

select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.trace_clickhouse_projections'::regclass),
  'the exposed-schema queue has RLS enabled'
);

select ok(
  not has_table_privilege(
    'authenticated', 'public.trace_clickhouse_projections', 'select'
  ),
  'authenticated clients cannot read internal projection jobs'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_trace_clickhouse_projection(text,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot claim projection jobs'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_trace_clickhouse_projection(text,integer,integer)',
    'execute'
  ),
  'the server worker can claim projection jobs'
);

create temporary table first_claim as
select * from public.claim_trace_clickhouse_projection('worker-a', 1, 120);

select is((select count(*)::int from first_claim), 1, 'the first worker claims the job');

select is(
  (select projection_attempt from first_claim),
  1,
  'the first claim carries attempt one for replacement semantics'
);

select is(
  (select count(*)::int
   from public.claim_trace_clickhouse_projection('worker-b', 1, 120)),
  0,
  'a second replica cannot steal a live lease'
);

select is(
  (select trace_projection_status from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  'running',
  'claim exposes running state on the low-cardinality receipt'
);

select is(
  public.nack_trace_clickhouse_projection(
    '6d100000-0000-0000-0000-000000000001',
    '6d200000-0000-0000-0000-000000000099',
    1,
    'wrong_worker'
  ),
  false,
  'nack is claim-token fenced'
);

select is(
  public.nack_trace_clickhouse_projection(
    '6d100000-0000-0000-0000-000000000001',
    (select claim_token from first_claim),
    1,
    'TimeoutError'
  ),
  true,
  'the lease owner releases a failed projection'
);

select is(
  (select trace_projection_error_code from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  'TimeoutError',
  'retry state stores only a sanitized error code'
);

update public.trace_clickhouse_projections
set available_at = now() - interval '1 second';

create temporary table second_claim as
select * from public.claim_trace_clickhouse_projection('worker-b', 1, 120);

select is(
  (select projection_attempt from second_claim),
  2,
  'a retry carries a higher replacement attempt'
);

select is(
  public.ack_trace_clickhouse_projection(
    '6d100000-0000-0000-0000-000000000001',
    (select claim_token from first_claim),
    2::bigint
  ),
  false,
  'ack is claim-token fenced'
);

select is(
  public.ack_trace_clickhouse_projection(
    '6d100000-0000-0000-0000-000000000001',
    (select claim_token from second_claim),
    2::bigint
  ),
  true,
  'the current lease owner acknowledges verified rows'
);

select is(
  (select count(*)::int from public.trace_clickhouse_projections),
  0,
  'ack removes the durable queue row'
);

select is(
  (select trace_projected_rows from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  2::bigint,
  'ack records the verified ClickHouse row count'
);

select is(
  (select status from public.trace_ingests
   where id = '6d100000-0000-0000-0000-000000000001'),
  'done',
  'ack of a complete_telemetry receipt keeps status done'
);

update public.trace_ingests
set trace_projection_status = 'error'
where id = '6d100000-0000-0000-0000-000000000001';

select is(
  public.enqueue_trace_clickhouse_backfill(100, 1::smallint),
  1,
  'backfill re-enqueues stale receipts without copying their payloads'
);

select ok(
  (select relrowsecurity from pg_catalog.pg_class
   where oid = 'public.trace_clickhouse_deletions'::regclass),
  'the exposed-schema deletion queue has RLS enabled'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_trace_clickhouse_deletion(text,integer,integer)',
    'execute'
  ),
  'authenticated clients cannot claim ClickHouse erasures'
);

delete from public.trace_ingests
where id = '6d100000-0000-0000-0000-000000000001';

select is(
  (select count(*)::int from public.trace_clickhouse_deletions),
  1,
  'deleting a projected receipt durably enqueues ClickHouse erasure'
);

create temporary table deletion_claim as
select * from public.claim_trace_clickhouse_deletion('worker-a', 10, 120);

select is(
  (select count(*)::int from deletion_claim),
  1,
  'one worker claims the tenant-scoped erasure'
);

select is(
  (select count(*)::int
   from public.claim_trace_clickhouse_deletion('worker-b', 10, 120)),
  0,
  'another replica cannot steal a live erasure lease'
);

select is(
  public.ack_trace_clickhouse_deletion(
    '6d100000-0000-0000-0000-000000000001',
    '6d200000-0000-0000-0000-000000000099'
  ),
  false,
  'ClickHouse erasure acknowledgement is claim-token fenced'
);

select is(
  public.ack_trace_clickhouse_deletion(
    '6d100000-0000-0000-0000-000000000001',
    (select claim_token from deletion_claim)
  ),
  true,
  'the current erasure owner removes the acknowledged job'
);

select * from finish();

rollback;
