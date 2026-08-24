begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

-- Personal-org provisioning is gated by the signups_enabled kill switch;
-- pin it on so this file keeps covering the open-signups behavior.
-- explabs_org_invitations.test.sql covers invite-only mode and invites.
update public.app_settings set signups_enabled = true;

-- Fixture: guarantee the demo-examples org holds one example world model with
-- an uploaded trace row so the example-copy path is observable.
-- Create-if-missing mirrors seed.sql, so the file passes on seeded and bare
-- stacks alike.
insert into public.organizations (id, slug, name)
values ('00000000-0000-0000-0000-000000000002', 'demo-examples', 'Demo Examples')
on conflict (id) do nothing;

insert into public.world_models (id, org_id, name, display_name, status, config)
values (
  '40000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-000000000002',
  'pgtap-example',
  'pgTAP Example',
  'created',
  '{"top_k": 5}'::jsonb
);

-- One post-build 'ingested' row (must be copied, like the real seed's) and
-- one failed row (must be skipped).
insert into public.trace_uploads
  (id, org_id, world_model_id, filename, storage_path, byte_size, sha256, trace_count, step_count, status)
values
  (
    '40000000-0000-0000-0000-00000000e002',
    '00000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-00000000e001',
    'pgtap-example.otel.jsonl',
    'traces/pgtap/pgtap-example.jsonl',
    42,
    'pgtap-example-digest',
    1,
    2,
    'ingested'
  ),
  (
    '40000000-0000-0000-0000-00000000e003',
    '00000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-00000000e001',
    'pgtap-example-failed.otel.jsonl',
    'traces/pgtap/pgtap-example-failed.jsonl',
    7,
    'pgtap-example-failed-digest',
    null,
    null,
    'failed'
  );

select isnt_empty(
  $$
  select 1
  from pg_trigger
  where tgname = 'provision_signup_org'
    and tgrelid = 'auth.users'::regclass
  $$,
  'signup provisioning trigger is attached to auth.users'
);

select has_function(
  'public',
  'ensure_account_starter_world_model',
  array['uuid', 'text', 'text'],
  'account starter-model provisioning is one atomic database function'
);

select function_privs_are(
  'public',
  'ensure_account_starter_world_model',
  array['uuid', 'text', 'text'],
  'service_role',
  array['EXECUTE'],
  'only the service backend can execute account starter-model provisioning'
);

-- A direct insert mirrors what GoTrue does on signup.
insert into auth.users (id, email)
values ('40000000-0000-0000-0000-000000000001', 'New.Person+test@example.com');

select isnt_empty(
  $$
  select 1
  from public.organizations orgs
  join public.organization_members members on members.org_id = orgs.id
  where members.user_id = '40000000-0000-0000-0000-000000000001'
    and members.role = 'admin'
  $$,
  'signup creates a personal org owned by the new user'
);

select is(
  (
    select orgs.slug
    from public.organizations orgs
    join public.organization_members members on members.org_id = orgs.id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
  ),
  'new-person-test-40000000',
  'personal org slug is the sanitized email local part plus a uuid prefix'
);

select is(
  (
    select count(*)::int
    from public.organization_members
    where user_id = '40000000-0000-0000-0000-000000000001'
  ),
  1,
  'signup creates exactly one membership'
);

select isnt_empty(
  $$
  select 1
  from public.account_workspaces workspaces
  where workspaces.user_id = '40000000-0000-0000-0000-000000000001'
    and workspaces.org_id in (
      select members.org_id
      from public.organization_members members
      where members.user_id = '40000000-0000-0000-0000-000000000001'
    )
  $$,
  'personal signup records its workspace for starter-world-model bootstrap'
);

select is(
  (
    select count(*)::int
    from public.optimizer_projects projects
    join public.organization_members members on members.org_id = projects.org_id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
  ),
  0,
  'signup does not create a default optimizer Project'
);

-- Signup no longer clones the demo-examples catalog into personal orgs
-- (2026-07-27): the shared catalog is the source of truth, and the account
-- starter world model arrives through the application layer instead.
select is(
  (
    select count(*)::int
    from public.world_models wm
    join public.organization_members members on members.org_id = wm.org_id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
  ),
  0,
  'signup leaves the fresh personal org without cloned catalog world models'
);

-- The starter RPC imports the catalog entry with its full lineage, including
-- the vendored eval-scenario set (2026-07-27: "seed everything").
insert into public.wm_catalog_entries (
  id, name, display_name, serve_provider, serve_model,
  storage_bucket, storage_path, byte_size, sha256,
  trace_count, step_count,
  traces_filename, traces_storage_path, traces_byte_size, traces_sha256,
  scenario_set
)
values (
  '40000000-0000-0000-0000-00000000c001',
  'pgtap-starter-entry',
  'pgTAP Starter',
  'bedrock',
  'claude-opus-4-8',
  'explabs-artifacts',
  'catalog/pgtap-starter/bundle.tar.gz',
  2048,
  repeat('d', 64),
  3,
  30,
  'pgtap-starter.otel.jsonl',
  'catalog/pgtap-starter/traces/corpus.otel.jsonl',
  1024,
  repeat('e', 64),
  jsonb_build_object(
    'payload', jsonb_build_object('scenarios', jsonb_build_array(
      jsonb_build_object('scenario_id', 's-1', 'task', 'pgTAP task')
    )),
    'scenario_count', 1,
    'budget', 20,
    'dropped_count', 19,
    'outcome_mix', jsonb_build_object('failure', 1),
    'corpus_traces', 3,
    'corpus_coverage', 0.5,
    'coverage_tau', 0.35,
    'provider', 'bedrock',
    'model', 'claude-opus-4-8'
  )
);

select isnt_empty(
  $$
  select 1
  from public.ensure_account_starter_world_model(
    '40000000-0000-0000-0000-000000000001',
    'pgtap-starter-entry',
    'default-world-model'
  )
  $$,
  'the starter RPC imports the catalog entry for the signup account workspace'
);

select is(
  (
    select count(*)::int
    from public.world_model_scenario_sets sets
    join public.world_models wm on wm.id = sets.world_model_id
    join public.organization_members members on members.org_id = wm.org_id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
      and wm.name = 'default-world-model'
      and sets.scenario_count = 1
      and sets.provider = 'bedrock'
      and sets.payload -> 'scenarios' -> 0 ->> 'task' = 'pgTAP task'
  ),
  1,
  'the starter import clones the entry''s vendored eval-scenario set'
);

-- The entry's counts prove the corpus was parsed when the published model
-- was built, so the clone is ingested data - the routing optimizer refuses
-- to cut sweep scenarios from a merely-uploaded corpus, and a starter whose
-- first training run fails with "no ingested trace upload" is the bug this
-- pins (same rule the API import path applies).
select is(
  (
    select uploads.status
    from public.trace_uploads uploads
    join public.world_models wm on wm.id = uploads.world_model_id
    join public.organization_members members on members.org_id = wm.org_id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
      and wm.name = 'default-world-model'
  ),
  'ingested',
  'the starter clone lands as ingested data, ready for the routing optimizer'
);

select is(
  (
    select count(*)::int
    from public.world_model_scenario_sets sets
    join public.build_jobs jobs on jobs.id = sets.build_job_id
    join public.world_models wm on wm.id = sets.world_model_id
    join public.organization_members members on members.org_id = wm.org_id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
      and wm.name = 'default-world-model'
      and jobs.runtime_backend = 'catalog-import'
      and jobs.world_model_id = wm.id
  ),
  1,
  'the cloned scenario set hangs off the catalog-import build job'
);

-- Backfill: an account provisioned before scenario vendoring existed (set
-- row missing, starter pointer already recorded) gets the set filled on its
-- next provision call through the early-return branch.
delete from public.world_model_scenario_sets sets
using public.world_models wm, public.organization_members members
where sets.world_model_id = wm.id
  and members.org_id = wm.org_id
  and members.user_id = '40000000-0000-0000-0000-000000000001';

select isnt_empty(
  $$
  select 1
  from public.ensure_account_starter_world_model(
    '40000000-0000-0000-0000-000000000001',
    'pgtap-starter-entry',
    'default-world-model'
  )
  $$,
  'a re-run against an already-provisioned account still returns the starter'
);

select is(
  (
    select count(*)::int
    from public.world_model_scenario_sets sets
    join public.world_models wm on wm.id = sets.world_model_id
    join public.organization_members members on members.org_id = wm.org_id
    where members.user_id = '40000000-0000-0000-0000-000000000001'
      and wm.name = 'default-world-model'
  ),
  1,
  'a pre-vendoring account gets the scenario set backfilled on re-provision'
);

-- Seeded admin users are provisioned explicitly by seed.sql and must not
-- receive a personal org.
select set_config('explabs.seed_admin_email', 'seeded-admin@example.com', true);

insert into auth.users (id, email)
values ('40000000-0000-0000-0000-000000000002', 'seeded-admin@example.com');

select is_empty(
  $$
  select 1
  from public.organization_members
  where user_id = '40000000-0000-0000-0000-000000000002'
  $$,
  'seeded admin email is exempt from personal org provisioning'
);

-- A user with no usable email local part still gets an org.
insert into auth.users (id, email)
values ('40000000-0000-0000-0000-000000000003', null);

select isnt_empty(
  $$
  select 1
  from public.organizations orgs
  join public.organization_members members on members.org_id = orgs.id
  where members.user_id = '40000000-0000-0000-0000-000000000003'
    and orgs.slug = 'user-40000000'
  $$,
  'null email falls back to a generic personal org slug'
);

select * from finish();

rollback;
