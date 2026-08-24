begin;

create extension if not exists pgtap with schema extensions;

select plan(21);

-- ---------------------------------------------------------------------------
-- Fixtures: two orgs, keys, and a spread of settled usage events across
-- aliases, lanes, hours, and terminal states. Events are inserted directly:
-- reads are under test, and the append-only trigger only blocks
-- update/delete. The "deleted key" case is modeled by pointing one event's
-- attribution snapshot (api_key_id has no foreign key by design) at a key id
-- with no api_keys row, because an actual key delete cascades into
-- gateway_requests and trips the usage-events append-only trigger.

insert into public.organizations (id, slug, name) values
  ('62000000-0000-0000-0000-000000000001', 'pgtap-gwu-tenant-a', 'pgTAP GW Usage A'),
  ('62000000-0000-0000-0000-000000000002', 'pgtap-gwu-tenant-b', 'pgTAP GW Usage B');

insert into public.api_keys (id, org_id, name, key_prefix, key_hash) values
  ('62000000-0000-0000-0000-000000000011', '62000000-0000-0000-0000-000000000001',
   'gwu-prod', 'xpl_gwup', encode(sha256('gwu-prod'::bytea), 'hex')),
  ('62000000-0000-0000-0000-000000000012', '62000000-0000-0000-0000-000000000001',
   'gwu-cli', 'xpl_gwuc', encode(sha256('gwu-cli'::bytea), 'hex')),
  ('62000000-0000-0000-0000-000000000021', '62000000-0000-0000-0000-000000000002',
   'gwu-other', 'xpl_gwuo', encode(sha256('gwu-other'::bytea), 'hex'));

insert into public.gateway_requests (
  request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
)
select
  ids.request_id, ids.org_id, ids.api_key_id, ids.alias, 'rev-1',
  'chat_completions', repeat('cd', 32),
  ids.finished_at - interval '2 seconds', ids.finished_at + interval '60 seconds',
  ids.status, ids.finished_at
from (values
  -- Key 11, alias haiku, platform lane, two events inside 10:00 UTC.
  ('req-a1', '62000000-0000-0000-0000-000000000001'::uuid,
   '62000000-0000-0000-0000-000000000011'::uuid, 'haiku',
   'completed', '2026-08-19 10:05:00+00'::timestamptz),
  ('req-a2', '62000000-0000-0000-0000-000000000001'::uuid,
   '62000000-0000-0000-0000-000000000011'::uuid, 'haiku',
   'failed', '2026-08-19 10:25:00+00'::timestamptz),
  -- Key 11, alias sonnet, byok lane, next hour.
  ('req-a3', '62000000-0000-0000-0000-000000000001'::uuid,
   '62000000-0000-0000-0000-000000000011'::uuid, 'sonnet',
   'completed', '2026-08-19 11:05:00+00'::timestamptz),
  -- Key 12 ("deleted" below), alias haiku, platform lane.
  ('req-a4', '62000000-0000-0000-0000-000000000001'::uuid,
   '62000000-0000-0000-0000-000000000012'::uuid, 'haiku',
   'completed', '2026-08-19 12:05:00+00'::timestamptz),
  -- Other org's event must never surface for org A.
  ('req-b1', '62000000-0000-0000-0000-000000000002'::uuid,
   '62000000-0000-0000-0000-000000000021'::uuid, 'haiku',
   'completed', '2026-08-19 10:05:00+00'::timestamptz),
  -- Key hard-deleted before settlement: the request's reference set-nulled.
  ('req-b2', '62000000-0000-0000-0000-000000000002'::uuid,
   null::uuid, 'haiku',
   'completed', '2026-08-19 10:35:00+00'::timestamptz)
) as ids(request_id, org_id, api_key_id, alias, status, finished_at);

insert into public.gateway_usage_events (
  request_id, org_id, api_key_id, alias, provider, lane,
  input_tokens, output_tokens, cost_micro_usd, estimated_cost_micro_usd,
  latency_ms, status, attempt_count, day, created_at
) values
  ('req-a1', '62000000-0000-0000-0000-000000000001',
   '62000000-0000-0000-0000-000000000011', 'haiku', 'anthropic',
   'platform_funded', 100, 20, 3000, 0, 400, 'completed', 1,
   '2026-08-19', '2026-08-19 10:05:00+00'),
  ('req-a2', '62000000-0000-0000-0000-000000000001',
   '62000000-0000-0000-0000-000000000011', 'haiku', 'anthropic',
   'platform_funded', 50, 0, 0, 0, 900, 'failed', 2,
   '2026-08-19', '2026-08-19 10:25:00+00'),
  -- Pure BYOK: charged 0, everything in the never-charged estimate.
  ('req-a3', '62000000-0000-0000-0000-000000000001',
   '62000000-0000-0000-0000-000000000011', 'sonnet', 'openai',
   'pass_through', 200, 40, 0, 9000, 700, 'completed', 1,
   '2026-08-19', '2026-08-19 11:05:00+00'),
  -- Attribution snapshot for a key whose api_keys row no longer exists.
  ('req-a4', '62000000-0000-0000-0000-000000000001',
   '62000000-0000-0000-0000-000000000013', 'haiku', 'anthropic',
   'platform_funded', 10, 5, 500, 0, 300, 'completed', 1,
   '2026-08-19', '2026-08-19 12:05:00+00'),
  ('req-b1', '62000000-0000-0000-0000-000000000002',
   '62000000-0000-0000-0000-000000000021', 'haiku', 'anthropic',
   'platform_funded', 999, 999, 99000, 0, 100, 'completed', 1,
   '2026-08-19', '2026-08-19 10:05:00+00'),
  ('req-b2', '62000000-0000-0000-0000-000000000002',
   null, 'haiku', 'anthropic',
   'platform_funded', 5, 5, 0, 0, 100, 'completed', 1,
   '2026-08-19', '2026-08-19 10:35:00+00');

-- ---------------------------------------------------------------------------
-- 1. Timeseries buckets, sums, and error accounting.

select is(
  (select count(*) from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000001', null, 3600
  )),
  3::bigint,
  'hourly bucketing yields one cell per (bucket, alias, lane)'
);

select results_eq(
  $$select request_count, error_count, input_tokens, output_tokens,
           cost_micro_usd, estimated_cost_micro_usd
      from public.gateway_usage_timeseries(
        '62000000-0000-0000-0000-000000000001', null, 3600
      )
     where bucket_start = '2026-08-19 10:00:00+00' and alias = 'haiku'$$,
  $$values (2::bigint, 1::bigint, 150::bigint, 20::bigint, 3000::bigint,
            0::bigint)$$,
  'a bucket counts all finished requests, errors included, and sums usage'
);

select results_eq(
  $$select cost_micro_usd, estimated_cost_micro_usd
      from public.gateway_usage_timeseries(
        '62000000-0000-0000-0000-000000000001', null, 3600
      )
     where alias = 'sonnet'$$,
  $$values (0::bigint, 9000::bigint)$$,
  'the pass-through lane keeps charged money and estimates split'
);

select is(
  (select count(*) from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000001', null, 3600, 'sonnet'
  )),
  1::bigint,
  'the alias filter narrows the timeseries'
);

select is(
  (select count(*) from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000001', null, 3600, null,
    '62000000-0000-0000-0000-000000000013'
  )),
  1::bigint,
  'the api-key filter narrows the timeseries'
);

select is(
  (select sum(request_count) from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000001', null, 3600, null, null,
    'pass_through'
  )),
  1::numeric,
  'the lane filter narrows the timeseries'
);

select is(
  (select count(*) from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000001', '2026-08-19 11:00:00+00', 3600
  )),
  2::bigint,
  'the window lower bound excludes older events'
);

select throws_ok(
  $$select * from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000001', null, 3600, null, null, 'platform'
  )$$,
  '22023',
  null,
  'a lane filter outside the storage vocabulary is refused'
);

select is(
  (select sum(cost_micro_usd) from public.gateway_usage_timeseries(
    '62000000-0000-0000-0000-000000000002', null, 3600
  )),
  99000::numeric,
  'each organization reads only its own events'
);

-- ---------------------------------------------------------------------------
-- 2. Per-key rollup.

select results_eq(
  $$select key_label, alias, request_count, error_count, cost_micro_usd,
           estimated_cost_micro_usd, last_used_at
      from public.gateway_usage_by_key('62000000-0000-0000-0000-000000000001')
     where api_key_id = '62000000-0000-0000-0000-000000000011'
     order by alias$$,
  $$values
    ('gwu-prod'::text, 'haiku'::text, 2::bigint, 1::bigint, 3000::bigint,
     0::bigint, '2026-08-19 10:25:00+00'::timestamptz),
    ('gwu-prod'::text, 'sonnet'::text, 1::bigint, 0::bigint, 0::bigint,
     9000::bigint, '2026-08-19 11:05:00+00'::timestamptz)$$,
  'the per-key rollup groups by (key, alias) with the api_keys label'
);

select is(
  (select key_label from public.gateway_usage_by_key(
    '62000000-0000-0000-0000-000000000001'
  ) where api_key_id = '62000000-0000-0000-0000-000000000013'),
  null::text,
  'a deleted key keeps its history under a null label'
);

select is(
  (select count(*) from public.gateway_usage_by_key(
    '62000000-0000-0000-0000-000000000001', '2026-08-19 12:00:00+00'
  )),
  1::bigint,
  'the per-key rollup honors the window lower bound'
);

-- The rollup returns highest-traffic cells first so that if a tenant ever
-- reaches the PostgREST max_rows cap the retained cells are deterministic
-- (highest volume) rather than an arbitrary truncated page.
select is(
  (select bool_and(request_count >= next_count) from (
     select request_count, lead(request_count) over () as next_count
       from public.gateway_usage_by_key('62000000-0000-0000-0000-000000000001')
   ) ordered where next_count is not null),
  true,
  'the per-key rollup returns cells in descending traffic order'
);

-- ---------------------------------------------------------------------------
-- 3. Event log: order, join, filters, keyset pagination.

select results_eq(
  $$select request_id, key_label from public.list_gateway_usage_events(
      '62000000-0000-0000-0000-000000000001'
    ) limit 2$$,
  $$values ('req-a4'::text, null::text), ('req-a3'::text, 'gwu-prod'::text)$$,
  'events list newest first with the key label joined'
);

select results_eq(
  $$select request_id from public.list_gateway_usage_events(
      '62000000-0000-0000-0000-000000000001', null, null, null, null, null,
      null, '2026-08-19 11:05:00+00', 'req-a3'
    )$$,
  $$values ('req-a2'::text), ('req-a1'::text)$$,
  'the (created_at, request_id) cursor returns strictly older rows'
);

select results_eq(
  $$select request_id from public.list_gateway_usage_events(
      '62000000-0000-0000-0000-000000000001', null, null, null, null, null,
      'error'
    )$$,
  $$values ('req-a2'::text)$$,
  'the error status shorthand selects every non-completed terminal state'
);

select results_eq(
  $$select request_id from public.list_gateway_usage_events(
      '62000000-0000-0000-0000-000000000001', null, null, 'haiku',
      '62000000-0000-0000-0000-000000000011', 'platform_funded'
    )$$,
  $$values ('req-a2'::text), ('req-a1'::text)$$,
  'alias, key, and lane filters compose on the event log'
);

select is(
  (select attempt_count from public.list_gateway_usage_events(
    '62000000-0000-0000-0000-000000000001'
  ) where request_id = 'req-a2'),
  2,
  'the event log carries the attempt count'
);

select throws_ok(
  $$select * from public.list_gateway_usage_events(
    '62000000-0000-0000-0000-000000000001', null, null, null, null, null, 'ok'
  )$$,
  '22023',
  null,
  'a status filter outside the terminal-state vocabulary is refused'
);

select is(
  (select count(*) from public.list_gateway_usage_events(
    '62000000-0000-0000-0000-000000000002'
  )),
  2::bigint,
  'the event log is org-scoped'
);

select results_eq(
  $$select request_count from public.gateway_usage_by_key(
      '62000000-0000-0000-0000-000000000002'
    ) where api_key_id is null and key_label is null$$,
  $$values (1::bigint)$$,
  'a key deleted before settlement groups under a null id and null label'
);

select * from finish();
rollback;
