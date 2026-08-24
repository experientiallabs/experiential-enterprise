begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

insert into public.organizations (id, slug, name)
values ('91000000-0000-0000-0000-000000000001', 'delete-cascade-org', 'Delete Cascade Org');

insert into public.world_models (id, org_id, name, status)
values (
  '91000000-0000-0000-0000-000000000003',
  '91000000-0000-0000-0000-000000000001',
  'delete-cascade-model',
  'ready'
);

-- Catalog provenance is shared and must outlive its source model. The source
-- pointer nulls on deletion; the entry and its likes remain available.
insert into public.wm_catalog_entries (
  id, name, serve_provider, serve_model, storage_path, byte_size, sha256,
  source_world_model_id
)
values (
  '91000000-0000-0000-0000-000000000013',
  'delete-cascade-catalog',
  'azure',
  'gpt-5.5',
  'catalog/delete-cascade/bundle.tar.gz',
  10,
  'catalog-sha',
  '91000000-0000-0000-0000-000000000003'
);

insert into public.wm_catalog_entry_likes (entry_id, user_id)
values (
  '91000000-0000-0000-0000-000000000013',
  '91000000-0000-0000-0000-000000000099'
);

-- First prove that deleting only an agent preserves its world model while
-- removing the complete optimizer-owned lineage.
insert into public.agents (
  id, org_id, world_model_id, name, agent_provider, agent_model
)
values (
  '91000000-0000-0000-0000-000000000004',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003',
  'delete-agent-only',
  'bedrock',
  'claude-haiku-4-5'
);

insert into public.agent_opt_runs (id, agent_id, iterations, k)
values (
  '91000000-0000-0000-0000-000000000005',
  '91000000-0000-0000-0000-000000000004',
  1,
  1
);

insert into public.agent_harness_versions (agent_id, version, doc, doc_hash, run_id)
values (
  '91000000-0000-0000-0000-000000000004',
  0,
  '{}'::jsonb,
  'agent-only-hash',
  '91000000-0000-0000-0000-000000000005'
);

insert into public.artifacts (
  id, org_id, world_model_id, agent_opt_run_id, kind,
  storage_path, byte_size, sha256
)
values (
  '91000000-0000-0000-0000-000000000015',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003',
  '91000000-0000-0000-0000-000000000005',
  'task_embeddings',
  'agent-runs/91000000-0000-0000-0000-000000000005/task-embeddings.json',
  10,
  'embedding-sha'
);

insert into public.storage_cleanup_jobs (
  id, resource_type, resource_id, objects
)
values (
  '91000000-0000-0000-0000-000000000016',
  'agent',
  '91000000-0000-0000-0000-000000000004',
  '[{"bucket":"explabs-artifacts","path":"agent-runs/91000000-0000-0000-0000-000000000005/task-embeddings.json"}]'::jsonb
);

delete from public.agents where id = '91000000-0000-0000-0000-000000000004';

select is((select count(*)::int from public.world_models where id = '91000000-0000-0000-0000-000000000003'), 1, 'agent deletion preserves its world model');
select is((select count(*)::int from public.agents where id = '91000000-0000-0000-0000-000000000004'), 0, 'agent row is deleted');
select is((select count(*)::int from public.agent_opt_runs where agent_id = '91000000-0000-0000-0000-000000000004'), 0, 'agent deletion cascades optimization runs');
select is((select count(*)::int from public.agent_harness_versions where agent_id = '91000000-0000-0000-0000-000000000004'), 0, 'agent deletion cascades harness versions');
select is((select count(*)::int from public.artifacts where agent_opt_run_id = '91000000-0000-0000-0000-000000000005'), 0, 'agent deletion cascades optimization-owned artifacts');
select is((select count(*)::int from public.storage_cleanup_jobs where resource_id = '91000000-0000-0000-0000-000000000004'), 1, 'agent deletion preserves its durable Storage cleanup outbox');

-- Populate every table in the world-model-owned graph, including a second
-- hosted agent, then prove one root delete removes the entire graph.
insert into public.trace_uploads (
  id, org_id, world_model_id, filename, storage_path, byte_size, sha256
)
values (
  '91000000-0000-0000-0000-000000000006',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003',
  'delete.jsonl',
  'traces/delete-cascade/delete.jsonl',
  10,
  'trace-sha'
);

insert into public.artifacts (
  id, org_id, world_model_id, kind, storage_path, byte_size, sha256
)
values (
  '91000000-0000-0000-0000-000000000007',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003',
  'world_model_bundle',
  'models/delete-cascade/bundle.tar.gz',
  10,
  'artifact-sha'
);

update public.world_models
set artifact_id = '91000000-0000-0000-0000-000000000007'
where id = '91000000-0000-0000-0000-000000000003';

insert into public.build_jobs (id, world_model_id, trace_upload_id)
values (
  '91000000-0000-0000-0000-000000000008',
  '91000000-0000-0000-0000-000000000003',
  '91000000-0000-0000-0000-000000000006'
);

insert into public.wm_sessions (id, org_id, world_model_id)
values (
  '91000000-0000-0000-0000-000000000009',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003'
);

insert into public.wm_steps (wm_session_id, step_index, action, observation)
values (
  '91000000-0000-0000-0000-000000000009',
  0,
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.wm_rollouts (
  id, org_id, world_model_id, agent_provider, agent_model, task, max_steps
)
values (
  '91000000-0000-0000-0000-000000000010',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003',
  'bedrock',
  'claude-haiku-4-5',
  'delete cascade task',
  1
);

insert into public.wm_rollout_turns (rollout_id, turn_index, role, content)
values (
  '91000000-0000-0000-0000-000000000010',
  0,
  'agent',
  '{}'::jsonb
);

insert into public.agents (
  id, org_id, world_model_id, name, agent_provider, agent_model
)
values (
  '91000000-0000-0000-0000-000000000011',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000003',
  'delete-with-model',
  'bedrock',
  'claude-haiku-4-5'
);

insert into public.agent_opt_runs (id, agent_id, iterations, k)
values (
  '91000000-0000-0000-0000-000000000012',
  '91000000-0000-0000-0000-000000000011',
  1,
  1
);

insert into public.agent_harness_versions (agent_id, version, doc, doc_hash, run_id)
values (
  '91000000-0000-0000-0000-000000000011',
  0,
  '{}'::jsonb,
  'model-agent-hash',
  '91000000-0000-0000-0000-000000000012'
);

-- The Storage cleanup outbox intentionally has no FK to the resource. It must
-- retain the exact object list after the relational graph disappears so a
-- transient Storage API outage can be retried.
insert into public.storage_cleanup_jobs (
  id, resource_type, resource_id, objects
)
values (
  '91000000-0000-0000-0000-000000000014',
  'world_model',
  '91000000-0000-0000-0000-000000000003',
  '[{"bucket":"explabs-artifacts","path":"models/delete-cascade/bundle.tar.gz"}]'::jsonb
);

delete from public.world_models where id = '91000000-0000-0000-0000-000000000003';

select is((select count(*)::int from public.world_models where id = '91000000-0000-0000-0000-000000000003'), 0, 'world model row is deleted');
select is((select count(*)::int from public.trace_uploads where world_model_id = '91000000-0000-0000-0000-000000000003'), 0, 'world model deletion cascades trace uploads');
select is((select count(*)::int from public.artifacts where world_model_id = '91000000-0000-0000-0000-000000000003'), 0, 'world model deletion cascades artifacts');
select is((select count(*)::int from public.build_jobs where world_model_id = '91000000-0000-0000-0000-000000000003'), 0, 'world model deletion cascades build jobs');
select is((select count(*)::int from public.wm_sessions where world_model_id = '91000000-0000-0000-0000-000000000003'), 0, 'world model deletion cascades serving sessions');
select is((select count(*)::int from public.wm_steps where wm_session_id = '91000000-0000-0000-0000-000000000009'), 0, 'world model deletion cascades serving steps');
select is((select count(*)::int from public.wm_rollouts where world_model_id = '91000000-0000-0000-0000-000000000003'), 0, 'world model deletion cascades playground rollouts');
select is((select count(*)::int from public.wm_rollout_turns where rollout_id = '91000000-0000-0000-0000-000000000010'), 0, 'world model deletion cascades rollout turns');
select is((select count(*)::int from public.agents where world_model_id = '91000000-0000-0000-0000-000000000003'), 0, 'world model deletion cascades agents');
select is((select count(*)::int from public.agent_opt_runs where agent_id = '91000000-0000-0000-0000-000000000011'), 0, 'world model deletion cascades agent runs');
select is((select count(*)::int from public.agent_harness_versions where agent_id = '91000000-0000-0000-0000-000000000011'), 0, 'world model deletion cascades agent harness versions');
select is((select count(*)::int from public.wm_catalog_entries where id = '91000000-0000-0000-0000-000000000013' and source_world_model_id is null), 1, 'world model deletion preserves shared catalog entries and clears provenance');
select is((select count(*)::int from public.wm_catalog_entry_likes where entry_id = '91000000-0000-0000-0000-000000000013'), 1, 'world model deletion preserves shared catalog likes');
select is((select count(*)::int from public.storage_cleanup_jobs where resource_id = '91000000-0000-0000-0000-000000000003'), 1, 'world model deletion preserves its durable Storage cleanup outbox');

select * from finish();

rollback;
