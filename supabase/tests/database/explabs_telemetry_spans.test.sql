begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

-- The telemetry projection layer: transcript-shaped rows from every source
-- table land in telemetry_spans via AFTER INSERT triggers, span sets group
-- optimizer output, and the two service-role RPCs are the only read path
-- the API uses.
select has_table('public', 'telemetry_spans', 'telemetry_spans exists');
select has_table('public', 'telemetry_span_sets', 'telemetry_span_sets exists');

select has_function(
  'public',
  'search_telemetry_spans',
  array[
    'uuid', 'text', 'text[]', 'text[]', 'text', 'boolean', 'uuid', 'uuid',
    'timestamp with time zone', 'timestamp with time zone', 'integer', 'integer',
    'uuid', 'uuid'
  ],
  'search_telemetry_spans exists with the filter signature'
);

select function_privs_are(
  'public',
  'search_telemetry_spans',
  array[
    'uuid', 'text', 'text[]', 'text[]', 'text', 'boolean', 'uuid', 'uuid',
    'timestamp with time zone', 'timestamp with time zone', 'integer', 'integer',
    'uuid', 'uuid'
  ],
  'service_role',
  array['EXECUTE'],
  'service_role can execute search_telemetry_spans'
);

select has_function(
  'public',
  'list_telemetry_groups',
  array[
    'uuid', 'text[]', 'text', 'timestamp with time zone',
    'timestamp with time zone', 'integer', 'integer', 'uuid', 'uuid'
  ],
  'list_telemetry_groups exists with the filter signature'
);

select function_privs_are(
  'public',
  'list_telemetry_groups',
  array[
    'uuid', 'text[]', 'text', 'timestamp with time zone',
    'timestamp with time zone', 'integer', 'integer', 'uuid', 'uuid'
  ],
  'service_role',
  array['EXECUTE'],
  'service_role can execute list_telemetry_groups'
);

-- Fixture graph: two orgs (the second proves isolation), one world model,
-- one serving session, one agent with a live session, one optimizer run
-- with an optimization rollout.
insert into public.organizations (id, slug, name)
values
  ('71000000-0000-0000-0000-000000000001', 'telemetry-org', 'Telemetry Org'),
  ('71000000-0000-0000-0000-000000000002', 'telemetry-other', 'Other Org');

insert into public.world_models (id, org_id, name, status)
values (
  '71000000-0000-0000-0000-000000000003',
  '71000000-0000-0000-0000-000000000001',
  'telemetry-test-model',
  'ready'
);

insert into public.wm_sessions (id, org_id, world_model_id)
values (
  '71000000-0000-0000-0000-000000000004',
  '71000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000003'
);

-- A serving step projects as one tool_call span with the observation folded
-- into its output.
insert into public.wm_steps (wm_session_id, step_index, action, observation, latency_ms)
values (
  '71000000-0000-0000-0000-000000000004',
  0,
  '{"kind": "tool_call", "name": "search_flights", "arguments": {"destination": "SFO"}}'::jsonb,
  '{"content": "two flights found", "is_error": false}'::jsonb,
  120
);

select is(
  (
    select count(*)::int
    from public.telemetry_spans
    where source = 'wm_session'
      and source_ref = '71000000-0000-0000-0000-000000000004'
  ),
  1,
  'a wm step projects one telemetry span'
);

select is(
  (
    select (kind, role, status, latency_ms)::text
    from public.telemetry_spans
    where source = 'wm_session'
      and source_ref = '71000000-0000-0000-0000-000000000004'
  ),
  '(tool_call,assistant,ok,120)',
  'the wm step span carries kind, role, status, and latency'
);

select is(
  (
    select count(*)::int
    from public.search_telemetry_spans(
      '71000000-0000-0000-0000-000000000001',
      'two flights'
    )
  ),
  1,
  'trigram search finds observation content'
);

-- Live agent session events: transcript kinds project, lifecycle kinds and
-- streaming tool_output chunks do not.
insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  '71000000-0000-0000-0000-000000000005',
  '71000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000003',
  'telemetry-agent',
  'anthropic',
  'claude-opus-4-8'
);

insert into public.agent_sessions (
  id, agent_id, org_id, harness_version, agent_model, agent_provider
)
values (
  '71000000-0000-0000-0000-000000000006',
  '71000000-0000-0000-0000-000000000005',
  '71000000-0000-0000-0000-000000000001',
  1,
  'claude-opus-4-8',
  'anthropic'
);

insert into public.agent_session_events (session_id, seq, kind, payload)
values
  (
    '71000000-0000-0000-0000-000000000006', 1, 'assistant_message',
    '{"text": "I will clone the repository"}'::jsonb
  ),
  (
    '71000000-0000-0000-0000-000000000006', 2, 'state',
    '{"status": "running"}'::jsonb
  ),
  (
    '71000000-0000-0000-0000-000000000006', 3, 'tool_call',
    '{"call_id": "c1", "name": "bash", "arguments": {"command": "git clone repo"}}'::jsonb
  ),
  (
    '71000000-0000-0000-0000-000000000006', 4, 'tool_result',
    '{"call_id": "c1", "content": "fatal: repository not found", "is_error": true, "truncated": false}'::jsonb
  );

select is(
  (
    select count(*)::int
    from public.telemetry_spans
    where source = 'agent_session'
      and source_ref = '71000000-0000-0000-0000-000000000006'
      and seq = 1
  ),
  1,
  'an assistant message projects one telemetry span'
);

select is(
  (
    select count(*)::int
    from public.telemetry_spans
    where source = 'agent_session'
      and source_ref = '71000000-0000-0000-0000-000000000006'
  ),
  3,
  'lifecycle state events do not project'
);

select is(
  (
    select status
    from public.telemetry_spans
    where source = 'agent_session'
      and source_ref = '71000000-0000-0000-0000-000000000006'
      and seq = 4
  ),
  'error',
  'a failed tool_result projects as an error span'
);

select is(
  (
    select model
    from public.telemetry_spans
    where source = 'agent_session'
      and source_ref = '71000000-0000-0000-0000-000000000006'
      and seq = 1
  ),
  'claude-opus-4-8',
  'the session model denormalizes onto its spans'
);

-- Optimizer runs get a span set on insert; optimization rollout turns attach
-- to it and carry the agent's reasoning channel.
insert into public.agent_opt_runs (
  id, agent_id, org_id, world_model_id, iterations, k, progress
)
values (
  '71000000-0000-0000-0000-000000000007',
  '71000000-0000-0000-0000-000000000005',
  '71000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000003',
  5,
  3,
  '{"iterations": [{"iteration": 0, "score": 0.5, "accepted": true}]}'::jsonb
);

select is(
  (
    select count(*)::int
    from public.telemetry_span_sets
    where kind = 'opt_run'
      and source_ref = '71000000-0000-0000-0000-000000000007'
  ),
  1,
  'an optimizer run upserts one opt_run span set'
);

insert into public.wm_rollouts (
  id, org_id, world_model_id, agent_model, agent_provider, task, max_steps,
  agent_opt_run_id, is_optimization
)
values (
  '71000000-0000-0000-0000-000000000008',
  '71000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000003',
  'claude-opus-4-8',
  'anthropic',
  'book a flight',
  10,
  '71000000-0000-0000-0000-000000000007',
  true
);

insert into public.wm_rollout_turns (rollout_id, turn_index, role, content)
values (
  '71000000-0000-0000-0000-000000000008',
  0,
  'agent',
  '{"kind": "tool_call", "name": "search", "arguments": {"q": "flight"}, "reasoning": "I should search for flights first"}'::jsonb
);

select is(
  (
    select span_set_id
    from public.telemetry_spans
    where source = 'rollout'
      and source_ref = '71000000-0000-0000-0000-000000000008'
  ),
  (
    select id
    from public.telemetry_span_sets
    where kind = 'opt_run'
      and source_ref = '71000000-0000-0000-0000-000000000007'
  ),
  'optimization rollout spans attach to the run''s span set'
);

select is(
  (
    select reasoning
    from public.telemetry_spans
    where source = 'rollout'
      and source_ref = '71000000-0000-0000-0000-000000000008'
  ),
  'I should search for flights first',
  'the rollout reasoning channel projects onto the span'
);

select is(
  (
    select count(*)::int
    from public.search_telemetry_spans(
      '71000000-0000-0000-0000-000000000001',
      null,
      in_has_reasoning => true
    )
  ),
  1,
  'the has-reasoning filter matches only reasoning spans'
);

select is(
  (
    select count(*)::int
    from public.search_telemetry_spans(
      '71000000-0000-0000-0000-000000000001',
      in_agent => '71000000-0000-0000-0000-000000000005'
    )
  ),
  3,
  'the agent filter matches the agent''s session spans'
);

select is(
  (
    select count(*)::int
    from public.search_telemetry_spans(
      '71000000-0000-0000-0000-000000000001',
      in_world_model => '71000000-0000-0000-0000-000000000003'
    )
  ),
  5,
  'the world-model filter spans serving, rollouts, and agent sessions'
);

select is(
  (
    select count(*)::int
    from public.search_telemetry_spans('71000000-0000-0000-0000-000000000002')
  ),
  0,
  'search never crosses org boundaries'
);

select is(
  (
    select array_agg(seq)
    from public.search_telemetry_spans(
      '71000000-0000-0000-0000-000000000001',
      in_source_ref => '71000000-0000-0000-0000-000000000006'
    )
  ),
  array[1, 3, 4]::bigint[],
  'transcript fetches read in event order'
);

select is(
  (
    select span_count
    from public.list_telemetry_groups('71000000-0000-0000-0000-000000000001')
    where source = 'agent_session'
  ),
  3::bigint,
  'groups aggregate span counts per source row'
);

-- A new upload of already-projected bytes clones the sibling's projection.
insert into public.trace_uploads (
  id, org_id, filename, storage_path, byte_size, sha256, status
)
values (
  '71000000-0000-0000-0000-000000000009',
  '71000000-0000-0000-0000-000000000001',
  'demo.otel.jsonl',
  'traces/none/original.jsonl',
  10,
  'sha-demo-bytes',
  'ingested'
);

insert into public.telemetry_span_sets (id, org_id, kind, label, source_ref, external_key)
values (
  '71000000-0000-0000-0000-000000000010',
  '71000000-0000-0000-0000-000000000001',
  'trace',
  'Demo trace',
  '71000000-0000-0000-0000-000000000009',
  'trace-aaaa'
);

insert into public.telemetry_spans (
  org_id, source, source_ref, span_set_id, trace_id, seq, kind, role,
  output, status, started_at, search_text
)
values (
  '71000000-0000-0000-0000-000000000001',
  'trace_upload',
  '71000000-0000-0000-0000-000000000009',
  '71000000-0000-0000-0000-000000000010',
  'trace-aaaa',
  0,
  'tool_call',
  'assistant',
  '{"content": "demo output", "is_error": false}'::jsonb,
  'ok',
  now(),
  'demo output'
);

insert into public.trace_uploads (
  id, org_id, filename, storage_path, byte_size, sha256, world_model_id, status
)
values (
  '71000000-0000-0000-0000-000000000011',
  '71000000-0000-0000-0000-000000000001',
  'demo-clone.otel.jsonl',
  'traces/none/clone.jsonl',
  10,
  'sha-demo-bytes',
  '71000000-0000-0000-0000-000000000003',
  'uploaded'
);

select is(
  (
    select count(*)::int
    from public.telemetry_spans
    where source = 'trace_upload'
      and source_ref = '71000000-0000-0000-0000-000000000011'
      and world_model_id = '71000000-0000-0000-0000-000000000003'
  ),
  1,
  'a sha-identical upload clones the sibling projection'
);

select is(
  (
    select sets.external_key
    from public.telemetry_spans spans
    join public.telemetry_span_sets sets on sets.id = spans.span_set_id
    where spans.source_ref = '71000000-0000-0000-0000-000000000011'
  ),
  'trace-aaaa',
  'cloned spans attach to the clone''s own trace set'
);

-- Deleting a producer removes its projection.
delete from public.wm_sessions
where id = '71000000-0000-0000-0000-000000000004';

select is(
  (
    select count(*)::int
    from public.telemetry_spans
    where source = 'wm_session'
      and source_ref = '71000000-0000-0000-0000-000000000004'
  ),
  0,
  'deleting the producer row deletes its spans'
);

select * from finish();

rollback;
