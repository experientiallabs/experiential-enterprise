begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

-- ---------------------------------------------------------------------------
-- Actor attribution on the alias activation chain (F1). The chain gained a
-- trailing `p_actor uuid default null`: activations stamp
-- gateway_alias_revisions.created_by, the named-alias delegate passes it
-- through, and every legacy actor-less call shape keeps working with a null
-- created_by. All ids are prefixed 'idar'/'75...' so ambient seed data cannot
-- perturb the assertions.

insert into public.organizations (id, slug, name) values
  ('75000000-0000-0000-0000-000000000001', 'idar-org', 'Alias Actor Org');

select public.gateway_register_catalog_snapshot(
  repeat('ef', 32), '{"deployments": ["dep-1"]}'::jsonb, '{"models": []}'::jsonb
);

-- ---------------------------------------------------------------------------
-- 1. Base activation stamps the actor.

select is(
  (select changed from public.gateway_activate_alias_revision(
    'idar-alias-a', 'idar-a', '75000000-0000-0000-0000-000000000001',
    'idar-rev-1', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ef', 32), '{}'::jsonb, null, false,
    '75000000-0000-0000-0000-0000000000aa')),
  true,
  'activating with an actor reports a change'
);

select is(
  (select created_by from public.gateway_alias_revisions
   where revision_id = 'idar-rev-1'),
  '75000000-0000-0000-0000-0000000000aa'::uuid,
  'the new revision records who activated it'
);

-- Idempotent replay by a DIFFERENT actor is still the no-op receipt, and
-- attribution keeps the first writer (actor is not revision content).

select is(
  (select changed from public.gateway_activate_alias_revision(
    'idar-alias-a', 'idar-a', '75000000-0000-0000-0000-000000000001',
    'idar-rev-1', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ef', 32), '{}'::jsonb, null, false,
    '75000000-0000-0000-0000-0000000000bb')),
  false,
  'replaying the active revision under another actor is a no-op'
);

select is(
  (select created_by from public.gateway_alias_revisions
   where revision_id = 'idar-rev-1'),
  '75000000-0000-0000-0000-0000000000aa'::uuid,
  'a replay never rewrites the original activator'
);

-- ---------------------------------------------------------------------------
-- 2. The named-alias delegate passes the actor through.

select is(
  (select changed from public.gateway_activate_named_alias_revision(
    'idar-named-1', 'idar-coding', '75000000-0000-0000-0000-000000000001',
    'idar-nrev-1', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ef', 32), '{}'::jsonb, null, false, null, 'idar-model-a',
    '75000000-0000-0000-0000-0000000000aa')),
  true,
  'a named-alias activation with an actor reports a change'
);

select is(
  (select created_by from public.gateway_alias_revisions
   where revision_id = 'idar-nrev-1'),
  '75000000-0000-0000-0000-0000000000aa'::uuid,
  'the named-alias revision carries the actor through the delegate'
);

-- ---------------------------------------------------------------------------
-- 3. Legacy actor-less call shapes still work and record no actor.

select is(
  (select changed from public.gateway_activate_alias_revision(
    'idar-alias-b', 'idar-b', '75000000-0000-0000-0000-000000000001',
    'idar-rev-2', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ef', 32), '{}'::jsonb, null)),
  true,
  'the pre-actor base call shape still activates'
);

select is(
  (select created_by from public.gateway_alias_revisions
   where revision_id = 'idar-rev-2'),
  null::uuid,
  'an actor-less activation leaves created_by null'
);

select is(
  (select changed from public.gateway_activate_named_alias_revision(
    'idar-named-2', 'idar-writing', '75000000-0000-0000-0000-000000000001',
    'idar-nrev-2', '{"pool_id": "pool-1", "deployment_ids": ["dep-1"]}'::jsonb,
    repeat('ef', 32), '{}'::jsonb, null, false, null, 'idar-model-b')),
  true,
  'the pre-actor named call shape still activates'
);

select is(
  (select created_by from public.gateway_alias_revisions
   where revision_id = 'idar-nrev-2'),
  null::uuid,
  'an actor-less named activation leaves created_by null'
);

-- ---------------------------------------------------------------------------
-- 4. Deactivation accepts the uniform actor parameter (audit emission is the
--    caller's job) and the legacy one-argument shape survives.

select is(
  (select changed from public.gateway_deactivate_alias(
    'idar-alias-a', '75000000-0000-0000-0000-0000000000aa')),
  true,
  'deactivation accepts the actor parameter'
);

select is(
  (select changed from public.gateway_deactivate_alias('idar-alias-b')),
  true,
  'the pre-actor deactivation call shape still works'
);

-- ---------------------------------------------------------------------------
-- 5. The revocation attribution column shipped alongside (F1: every
--    soft-delete has revoked_at, revocation now has a revoked_by to fill).

select has_column(
  'public', 'api_keys', 'revoked_by',
  'api_keys records who revoked a key'
);

select * from finish();

rollback;
