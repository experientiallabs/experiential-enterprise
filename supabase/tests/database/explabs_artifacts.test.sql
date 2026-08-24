begin;

create extension if not exists pgtap with schema extensions;

select plan(7);

-- Shape: the artifacts row is the canonical built-bundle metadata contract
-- read by explabs/db/stores/artifact_store.py.
select columns_are(
  'public',
  'artifacts',
  array[
    'id',
    'org_id',
    'world_model_id',
    'agent_opt_run_id',
    'kind',
    'storage_bucket',
    'storage_path',
    'byte_size',
    'sha256',
    'created_at'
  ],
  'artifacts exposes exactly the canonical bundle-metadata columns'
);

-- Fixture graph: one org with a member, one world model, and one built
-- bundle artifact linked in both directions.
insert into public.organizations (id, slug, name)
values ('70000000-0000-0000-0000-000000000001', 'artifact-rls-org', 'Artifact RLS Org');

insert into public.organization_members (org_id, user_id, role)
values (
  '70000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000099',
  'user'
);

insert into public.world_models (id, org_id, name, status)
values (
  '70000000-0000-0000-0000-000000000003',
  '70000000-0000-0000-0000-000000000001',
  'artifact-test-model',
  'ready'
);

insert into public.artifacts (
  id,
  org_id,
  world_model_id,
  kind,
  storage_path,
  byte_size,
  sha256
)
values (
  '70000000-0000-0000-0000-000000000004',
  '70000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000003',
  'world_model_bundle',
  'models/70000000-0000-0000-0000-000000000003/bundle.tar.gz',
  1024,
  repeat('a', 64)
);

update public.world_models
set artifact_id = '70000000-0000-0000-0000-000000000004'
where id = '70000000-0000-0000-0000-000000000003';

-- Rows default to the platform bucket unless the writer overrides it.
select is(
  (
    select storage_bucket
    from public.artifacts
    where id = '70000000-0000-0000-0000-000000000004'
  ),
  'explabs-artifacts',
  'storage_bucket defaults to the platform artifacts bucket'
);

-- One metadata row per storage object, platform-wide.
select throws_ok(
  $$
  insert into public.artifacts (org_id, kind, storage_path, byte_size, sha256)
  values (
    '70000000-0000-0000-0000-000000000001',
    'world_model_bundle',
    'models/70000000-0000-0000-0000-000000000003/bundle.tar.gz',
    2048,
    repeat('b', 64)
  )
  $$,
  '23505',
  null,
  'duplicate storage paths are rejected'
);

-- Integrity metadata is mandatory and sane.
select throws_ok(
  $$
  insert into public.artifacts (org_id, kind, storage_path, byte_size, sha256)
  values (
    '70000000-0000-0000-0000-000000000001',
    'world_model_bundle',
    'models/70000000-0000-0000-0000-000000000003/negative.tar.gz',
    -1,
    repeat('c', 64)
  )
  $$,
  '23514',
  null,
  'negative byte sizes are rejected'
);

-- An authenticated org member sees the org's artifacts.
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000099', true);
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.artifacts
    where id = '70000000-0000-0000-0000-000000000004'
  ),
  1,
  'org member reads the org artifact metadata'
);

-- Authenticated users have no write path; only the service role writes.
select throws_ok(
  $$
  insert into public.artifacts (org_id, kind, storage_path, byte_size, sha256)
  values (
    '70000000-0000-0000-0000-000000000001',
    'world_model_bundle',
    'models/70000000-0000-0000-0000-000000000003/member.tar.gz',
    1,
    repeat('d', 64)
  )
  $$,
  '42501',
  null,
  'authenticated members cannot insert artifacts'
);

reset role;

-- A user outside the org sees nothing.
select set_config('request.jwt.claim.sub', '70000000-0000-0000-0000-000000000098', true);
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.artifacts
    where id = '70000000-0000-0000-0000-000000000004'
  ),
  0,
  'non-members cannot read another org''s artifacts'
);

reset role;

select * from finish();

rollback;
