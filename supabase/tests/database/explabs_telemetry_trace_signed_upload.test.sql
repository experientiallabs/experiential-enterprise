begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

insert into public.organizations (id, slug, name) values (
  '7d000000-0000-0000-0000-000000000001',
  'pgtap-trace-signed-upload',
  'pgTAP Trace Signed Upload'
);

insert into public.trace_ingests (
  id, org_id, source, status, upload_path
) values (
  '7d100000-0000-0000-0000-000000000001',
  '7d000000-0000-0000-0000-000000000001',
  '{"kind":"file","source_kind":"otlp","source_label":"prod"}'::jsonb,
  'pending',
  'orgs/7d/traces/reserved'
);

select is(
  (
    select accepted.status
    from public.accept_telemetry_trace_ingest(
      '7d100000-0000-0000-0000-000000000001'
    ) accepted
  ),
  'running',
  'accept flips a pending reservation to running'
);

select is(
  (select count(*)::int from public.trace_clickhouse_projections),
  1,
  'accept enqueues exactly one projection job'
);

select is(
  (
    select accepted.status
    from public.accept_telemetry_trace_ingest(
      '7d100000-0000-0000-0000-000000000001'
    ) accepted
  ),
  'running',
  'a second accept is idempotent'
);

select is(
  (select count(*)::int from public.trace_clickhouse_projections),
  1,
  'idempotent accept does not duplicate the queue row'
);

create temporary table signed_claim as
select * from public.claim_trace_clickhouse_projection('worker-signed', 1, 120);

select is((select count(*)::int from signed_claim), 1, 'the worker can claim the accepted job');

select is(
  (
    select recorded.object_sha256
    from public.record_telemetry_trace_object(
      '7d100000-0000-0000-0000-000000000001',
      (select claim_token from signed_claim),
      repeat('b', 64),
      12::bigint,
      2
    ) recorded
  ),
  repeat('b', 64),
  'the worker records the verified digest while the claim is live'
);

select is(
  public.fail_telemetry_trace_ingest(
    '7d100000-0000-0000-0000-000000000001',
    '7d200000-0000-0000-0000-000000000099',
    'object_missing',
    'wrong token'
  ),
  false,
  'terminal fail is claim-token fenced'
);

select is(
  public.fail_telemetry_trace_ingest(
    '7d100000-0000-0000-0000-000000000001',
    (select claim_token from signed_claim),
    'object_malformed',
    'invalid json'
  ),
  true,
  'the lease owner can record a typed terminal validation error'
);

select is(
  (select error_code from public.trace_ingests
   where id = '7d100000-0000-0000-0000-000000000001'),
  'object_malformed',
  'the receipt stores the typed terminal error'
);

select is(
  (select count(*)::int from public.trace_clickhouse_projections),
  0,
  'terminal fail removes the durable queue row'
);

select is(
  public.ack_abandoned_telemetry_trace_ingest(
    '7d100000-0000-0000-0000-000000000001',
    false
  ),
  true,
  'failed-upload cleanup clears object locators and keeps the error receipt'
);

insert into public.trace_ingests (
  id, org_id, source, status, upload_path, created_at
) values (
  '7d100000-0000-0000-0000-000000000002',
  '7d000000-0000-0000-0000-000000000001',
  '{"kind":"file","source_kind":"otlp","source_label":"stale"}'::jsonb,
  'pending',
  'orgs/7d/traces/stale',
  now() - interval '3 hours'
);

select is(
  (
    select count(*)::int
    from public.claim_abandoned_telemetry_trace_ingests(7200, 16)
  ),
  1,
  'abandoned reservations older than the signed-url lifetime are claimed'
);

select is(
  public.ack_abandoned_telemetry_trace_ingest(
    '7d100000-0000-0000-0000-000000000002',
    true
  ),
  true,
  'abandoned cleanup deletes the reservation after Storage deletion'
);

insert into public.trace_ingests (
  id, org_id, source, status, upload_path
) values (
  '7d100000-0000-0000-0000-000000000003',
  '7d000000-0000-0000-0000-000000000001',
  '{"kind":"file","source_kind":"otlp","source_label":"ok"}'::jsonb,
  'pending',
  'orgs/7d/traces/ok'
);

select is(
  (
    select accepted.status
    from public.accept_telemetry_trace_ingest(
      '7d100000-0000-0000-0000-000000000003'
    ) accepted
  ),
  'running',
  'a successful reservation stays running until the worker acks'
);

create temporary table signed_success_claim as
select * from public.claim_trace_clickhouse_projection('worker-signed-ok', 1, 120);

select is(
  public.ack_trace_clickhouse_projection(
    '7d100000-0000-0000-0000-000000000003',
    (select claim_token from signed_success_claim),
    2::bigint
  ),
  true,
  'the lease owner acknowledges a successful signed-upload projection'
);

select is(
  (select status from public.trace_ingests
   where id = '7d100000-0000-0000-0000-000000000003'),
  'done',
  'claim-fenced ack is what public polling observes as status=done'
);

insert into public.world_models (id, org_id, name, status)
values (
  '7d300000-0000-0000-0000-000000000001',
  '7d000000-0000-0000-0000-000000000001',
  'pgtap-project-model',
  'created'
);

insert into public.trace_ingests (
  id, org_id, world_model_id, source, status, upload_path
) values (
  '7d100000-0000-0000-0000-000000000004',
  '7d000000-0000-0000-0000-000000000001',
  '7d300000-0000-0000-0000-000000000001',
  '{"kind":"file"}'::jsonb,
  'running',
  'orgs/7d/projects/traces'
);

insert into public.trace_clickhouse_projections (ingest_id, org_id, projection_version)
values (
  '7d100000-0000-0000-0000-000000000004',
  '7d000000-0000-0000-0000-000000000001',
  1
);

create temporary table project_claim as
select * from public.claim_trace_clickhouse_projection('worker-project', 1, 120);

select is(
  public.ack_trace_clickhouse_projection(
    '7d100000-0000-0000-0000-000000000004',
    (select claim_token from project_claim),
    1::bigint
  ),
  true,
  'project ingest projection ack is still claim-token fenced'
);

select is(
  (select status from public.trace_ingests
   where id = '7d100000-0000-0000-0000-000000000004'),
  'running',
  'ack does not rewrite a project ingest status'
);

select * from finish();

rollback;
