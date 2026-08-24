begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

-- Fixtures: one org with traffic across two providers plus one undispatched
-- event (null provider), and a second org whose rows must never surface.

insert into public.organizations (id, slug, name) values
  ('65000000-0000-0000-0000-000000000001', 'pgtap-gwp-tenant-a', 'pgTAP GW Provider A'),
  ('65000000-0000-0000-0000-000000000002', 'pgtap-gwp-tenant-b', 'pgTAP GW Provider B');

insert into public.gateway_requests (
  request_id, org_id, alias, alias_revision_id, api_surface,
  canonical_request_sha256, accepted_at, deadline_at, terminal_state, terminal_at
)
select
  ids.request_id, ids.org_id, ids.alias, 'rev-1',
  'chat_completions', repeat('ab', 32),
  ids.finished_at - interval '2 seconds', ids.finished_at + interval '60 seconds',
  ids.status, ids.finished_at
from (values
  ('req-p1', '65000000-0000-0000-0000-000000000001'::uuid, 'haiku',
   'completed', '2026-08-19 10:05:00+00'::timestamptz),
  ('req-p2', '65000000-0000-0000-0000-000000000001'::uuid, 'haiku',
   'failed', '2026-08-19 10:25:00+00'::timestamptz),
  ('req-p3', '65000000-0000-0000-0000-000000000001'::uuid, 'sonnet',
   'completed', '2026-08-19 11:05:00+00'::timestamptz),
  ('req-p4', '65000000-0000-0000-0000-000000000001'::uuid, 'haiku',
   'failed', '2026-08-19 12:05:00+00'::timestamptz),
  ('req-p5', '65000000-0000-0000-0000-000000000002'::uuid, 'haiku',
   'completed', '2026-08-19 10:05:00+00'::timestamptz)
) as ids(request_id, org_id, alias, status, finished_at);

insert into public.gateway_usage_events (
  request_id, org_id, alias, provider, lane,
  input_tokens, output_tokens, cost_micro_usd, estimated_cost_micro_usd,
  latency_ms, status, attempt_count, day, created_at
) values
  ('req-p1', '65000000-0000-0000-0000-000000000001', 'haiku', 'anthropic',
   'platform_funded', 100, 20, 3000, 0, 400, 'completed', 1,
   '2026-08-19', '2026-08-19 10:05:00+00'),
  ('req-p2', '65000000-0000-0000-0000-000000000001', 'haiku', 'anthropic',
   'platform_funded', 50, 0, 0, 0, 900, 'failed', 2,
   '2026-08-19', '2026-08-19 10:25:00+00'),
  ('req-p3', '65000000-0000-0000-0000-000000000001', 'sonnet', 'openai',
   'pass_through', 200, 40, 0, 9000, 700, 'completed', 1,
   '2026-08-19', '2026-08-19 11:05:00+00'),
  -- Nothing was dispatched: no provider, no lane, no usage.
  ('req-p4', '65000000-0000-0000-0000-000000000001', 'haiku', null,
   null, 0, 0, 0, 0, 50, 'failed', 0,
   '2026-08-19', '2026-08-19 12:05:00+00'),
  ('req-p5', '65000000-0000-0000-0000-000000000002', 'haiku', 'anthropic',
   'platform_funded', 999, 999, 99000, 0, 100, 'completed', 1,
   '2026-08-19', '2026-08-19 10:05:00+00');

select is(
  (select count(*) from public.gateway_usage_by_provider(
    '65000000-0000-0000-0000-000000000001'
  )),
  3::bigint,
  'one row per provider, the undispatched null group included'
);

select results_eq(
  $$select request_count, error_count, input_tokens, output_tokens,
           cost_micro_usd, estimated_cost_micro_usd, last_used_at
      from public.gateway_usage_by_provider(
        '65000000-0000-0000-0000-000000000001'
      )
     where provider = 'anthropic'$$,
  $$values (2::bigint, 1::bigint, 150::bigint, 20::bigint, 3000::bigint,
            0::bigint, '2026-08-19 10:25:00+00'::timestamptz)$$,
  'a provider row counts all finished requests, errors included, and sums usage'
);

select results_eq(
  $$select cost_micro_usd, estimated_cost_micro_usd
      from public.gateway_usage_by_provider(
        '65000000-0000-0000-0000-000000000001'
      )
     where provider = 'openai'$$,
  $$values (0::bigint, 9000::bigint)$$,
  'the charged/estimated money split survives the provider rollup'
);

select is(
  (select request_count from public.gateway_usage_by_provider(
    '65000000-0000-0000-0000-000000000001'
  ) where provider is null),
  1::bigint,
  'undispatched requests group under the null provider instead of vanishing'
);

select is(
  (select count(*) from public.gateway_usage_by_provider(
    '65000000-0000-0000-0000-000000000001',
    '2026-08-19 11:00:00+00'
  )),
  2::bigint,
  'the window bound excludes earlier traffic'
);

select * from finish();
rollback;
