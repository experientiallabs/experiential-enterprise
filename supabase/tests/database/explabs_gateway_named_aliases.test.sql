begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

-- ---------------------------------------------------------------------------
-- Named / abstract aliases (P-E). gateway_activate_named_alias_revision marks
-- an alias origin='named' and delegates create / repoint / rollback to int-p1's
-- gateway_activate_alias_revision, recording the backing model per revision.
-- All ids are prefixed 'idpe'/'72...' so ambient seed data cannot perturb the
-- assertions.

insert into public.organizations (id, slug, name) values
  ('72000000-0000-0000-0000-000000000001', 'idpe-org-a', 'Identity PE Org A');

-- One catalog snapshot both target pools live in.
select public.gateway_register_catalog_snapshot(
  repeat('ab', 32),
  '{"deployments": ["dep-1", "dep-2"]}'::jsonb,
  '{"models": []}'::jsonb
);

-- A catalog alias in org A, to prove the named path cannot hijack it.
select public.gateway_activate_alias_revision(
  'idpe-cat-shared', 'idpe-shared', '72000000-0000-0000-0000-000000000001',
  'idpe-cat-rev', '{"kind": "direct", "pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
  repeat('ab', 32), '{}'::jsonb, null
);

-- ---------------------------------------------------------------------------
-- Create: coding -> pool-1.

select is(
  (select changed from public.gateway_activate_named_alias_revision(
    'idpe-named-coding', 'coding', '72000000-0000-0000-0000-000000000001',
    'idpe-nrev-1', '{"kind": "direct", "pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null, false, null, 'idpe-model-a')),
  true,
  'creating a named alias reports a change'
);

select is(
  (select origin from public.gateway_aliases where alias_id = 'idpe-named-coding'),
  'named',
  'a named alias carries origin=named'
);

select is(
  (select current_revision_id from public.gateway_aliases where alias_id = 'idpe-named-coding'),
  'idpe-nrev-1',
  'the current revision points at the first activation'
);

select is(
  (select active from public.gateway_aliases where alias_id = 'idpe-named-coding'),
  true,
  'a freshly created named alias is active'
);

select is(
  (select model_slug from public.gateway_named_alias_targets where revision_id = 'idpe-nrev-1'),
  'idpe-model-a',
  'the backing model is recorded for the first revision'
);

-- ---------------------------------------------------------------------------
-- Repoint: coding -> pool-2 (a new revision).

select is(
  (select changed from public.gateway_activate_named_alias_revision(
    'idpe-named-coding', 'coding', '72000000-0000-0000-0000-000000000001',
    'idpe-nrev-2', '{"kind": "direct", "pool_id": "pool-2", "deployment_ids": ["dep-2"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null, false, null, 'idpe-model-b')),
  true,
  'repointing a named alias reports a change'
);

select is(
  (select current_revision_id from public.gateway_aliases where alias_id = 'idpe-named-coding'),
  'idpe-nrev-2',
  'the current revision moves to the repointed target'
);

select is(
  (select model_slug from public.gateway_named_alias_targets where revision_id = 'idpe-nrev-2'),
  'idpe-model-b',
  'the backing model is recorded for the repoint revision'
);

select is(
  (select (target ->> 'pool_id') from public.gateway_alias_revisions where revision_id = 'idpe-nrev-2'),
  'pool-2',
  'the repoint revision stores the new pool'
);

-- ---------------------------------------------------------------------------
-- Rollback: re-activate the original revision.

select is(
  (select changed from public.gateway_activate_named_alias_revision(
    'idpe-named-coding', 'coding', '72000000-0000-0000-0000-000000000001',
    'idpe-nrev-1', '{"kind": "direct", "pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ab', 32), '{}'::jsonb, null, false, null, 'idpe-model-a')),
  true,
  'rolling back to a prior revision reports a change'
);

select is(
  (select current_revision_id from public.gateway_aliases where alias_id = 'idpe-named-coding'),
  'idpe-nrev-1',
  'the current revision returns to the rolled-back target'
);

select is(
  (select count(*)::int from public.gateway_alias_revisions where alias_id = 'idpe-named-coding'),
  2,
  'rollback reuses the existing revision rather than inventing a new one'
);

-- ---------------------------------------------------------------------------
-- Guards.

select throws_ok(
  $$select public.gateway_activate_named_alias_revision(
      'idpe-named-null', 'orgless', null,
      'idpe-nrev-null', '{"kind": "direct", "pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
      repeat('ab', 32), '{}'::jsonb, null, false, null, 'idpe-model-a')$$,
  '23514', null,
  'a named alias with no organization is rejected'
);

select throws_ok(
  $$select public.gateway_activate_named_alias_revision(
      'idpe-named-collide', 'idpe-shared', '72000000-0000-0000-0000-000000000001',
      'idpe-nrev-collide', '{"kind": "direct", "pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
      repeat('ab', 32), '{}'::jsonb, null, false, null, 'idpe-model-a')$$,
  '23505', null,
  'a named alias cannot reuse a catalog alias name in the same org'
);

select throws_ok(
  $$select public.gateway_activate_named_alias_revision(
      'idpe-cat-shared', 'idpe-shared-2', '72000000-0000-0000-0000-000000000001',
      'idpe-nrev-hijack', '{"kind": "direct", "pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
      repeat('ab', 32), '{}'::jsonb, null, false, null, 'idpe-model-a')$$,
  '23505', null,
  'the named path cannot repurpose an existing catalog alias id'
);

select * from finish();

rollback;
