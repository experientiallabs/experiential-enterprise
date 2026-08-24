begin;

create extension if not exists pgtap with schema extensions;

select plan(3);

-- ---------------------------------------------------------------------------
-- Catalog availability: gateway_activate_alias_revision raises the org FK
-- violation for an alias whose organization row is gone (replication-role
-- writes bypass cascade triggers, so ordinary data operations can leave such
-- orphans). The catalog builder relies on exactly this typed failure to skip
-- ONE alias per store pass instead of aborting the whole catalog and keeping
-- every gateway worker from loading. Ids are prefixed '74'/'avail' so ambient
-- seed data cannot perturb the assertions.

select public.gateway_register_catalog_snapshot(
  repeat('cd', 32),
  '{"deployments": ["dep-avail-1"]}'::jsonb,
  '{"models": []}'::jsonb
);

-- The failure the builder skips per-alias: a missing org raises 23503.
select throws_ok(
  $$select public.gateway_activate_alias_revision(
    'avail-orphan', 'avail-orphan', '74000000-0000-0000-0000-00000000dead',
    'avail-orphan-rev',
    '{"kind": "direct", "pool_id": "pool-avail", "deployment_ids": ["dep-avail-1"]}'::jsonb,
    repeat('cd', 32), '{}'::jsonb, null)$$,
  '23503',
  null,
  'activating an alias for a missing organization raises the org FK violation'
);

-- Control: the same activation succeeds once the organization exists, so the
-- builder''s per-alias skip only ever drops genuinely orphaned aliases.
insert into public.organizations (id, slug, name) values
  ('74000000-0000-0000-0000-000000000001', 'avail-org', 'Catalog Availability Org');

select is(
  (select changed from public.gateway_activate_alias_revision(
    'avail-owned', 'avail-owned', '74000000-0000-0000-0000-000000000001',
    'avail-owned-rev',
    '{"kind": "direct", "pool_id": "pool-avail", "deployment_ids": ["dep-avail-1"]}'::jsonb,
    repeat('cd', 32), '{}'::jsonb, null)),
  true,
  'the same activation succeeds for an existing organization'
);

select is(
  (select active from public.gateway_aliases where alias_id = 'avail-owned'),
  true,
  'the owned alias is active after activation'
);

select * from finish();

rollback;
