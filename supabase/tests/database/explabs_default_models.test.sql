begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- Shape: one row per curated default on the /models door. The defaults
-- themselves are the READY ENDPOINTS of the default-models workspace; this
-- table is display copy only (headline retired). Control-plane data read only
-- through the FastAPI backend (service role); the web tier never reads it via
-- PostgREST, so the fence is "no policies", not a grant.
select has_table(
  'public',
  'default_models',
  'the default-model curation table exists'
);

select columns_are(
  'public',
  'default_models',
  array[
    'id',
    'slug',
    'title',
    'benchmark',
    'description',
    'tags',
    'world_model_slug',
    'catalog_entry_name',
    'headline',
    'display_order',
    'created_at'
  ],
  'default_models carries exactly the curation contract'
);

select has_index(
  'public',
  'default_models',
  'default_models_slug_idx',
  'slug is unique: a curation row enriches exactly one workspace endpoint'
);

select has_index(
  'public',
  'default_models',
  'default_models_display_order_idx',
  'display_order is unique so the gallery order is total'
);

-- Lockdown posture, matching wm_catalog_entries: RLS enabled with zero
-- policies means anon/authenticated read nothing and the service-role backend
-- is the single reader/writer.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.default_models'::regclass),
  'row level security is enabled'
);

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'default_models'),
  0,
  'no policies: service-role only, like the other control-plane tables'
);

-- Guards: malformed rows must be refused at the boundary.
select throws_ok(
  $$insert into public.default_models
      (id, slug, title, benchmark, description, display_order)
    values ('10000000-0000-0000-0000-000000000001', 'Bad Slug', 't', 'b', 'd', 99)$$,
  '23514',
  null,
  'a non-slug slug is refused'
);

select throws_ok(
  $$insert into public.default_models
      (id, slug, title, benchmark, description, tags, display_order)
    values ('10000000-0000-0000-0000-000000000002', 'ok-slug', 't', 'b', 'd',
            '"not-an-array"'::jsonb, 98)$$,
  '23514',
  null,
  'tags must be a json array'
);

-- The default-models workspace: the org whose endpoints ARE the published
-- defaults (the product owner, 2026-07-30). No members; platform admins curate it through
-- their bypass.
select is(
  (select slug from public.organizations
   where id = '00000000-0000-0000-0000-000000000003'),
  'default-models',
  'the default-models workspace org is seeded at its stable id'
);

select is(
  (select count(*)::int from public.organization_members
   where org_id = '00000000-0000-0000-0000-000000000003'),
  0,
  'the workspace has no members: admin bypass is the only door'
);

select is(
  (select array_agg(name order by name) from public.endpoints
   where org_id = '00000000-0000-0000-0000-000000000003' and status = 'ready'),
  array['coding', 'customer-support', 'terminal-use'],
  'the three seeded defaults live in the workspace, ready'
);

select is(
  (select count(*)::int from public.endpoints
   where org_id = '00000000-0000-0000-0000-000000000003' and report is null),
  0,
  'every seeded default carries an installed report: numbers derive from it'
);

-- The curation rows: copy only, one per seeded default, numbers RETIRED.
select is(
  (select array_agg(slug order by display_order) from public.default_models),
  array['customer-support', 'terminal-use', 'coding'],
  'curation copy exists for the three defaults in display order'
);

select is(
  (select count(*)::int from public.default_models where headline is not null),
  0,
  'headline is retired: no hand-written figure survives in the curation table'
);

-- The adoption path (migration 20260730160000): moving a model into the
-- workspace is one atomic function call, and everything below runs inside
-- this suite's rollback so no probe row survives.
select has_function(
  'public',
  'adopt_default_model',
  array['uuid'],
  'the workspace adoption function is installed'
);

insert into public.organizations (id, slug, name)
values ('0a000000-0000-4000-8000-00000000aaaa', 'tmp-adopt-src', 'Tmp');
insert into public.endpoints (id, org_id, name, status, policy)
values (
  'e0000000-0000-4000-8000-00000000aaaa',
  '0a000000-0000-4000-8000-00000000aaaa',
  'adopt-probe',
  'ready',
  '{"kind": "static"}'::jsonb
);
select public.adopt_default_model('e0000000-0000-4000-8000-00000000aaaa');

select is(
  (select org_id from public.endpoints
   where id = 'e0000000-0000-4000-8000-00000000aaaa'),
  '00000000-0000-0000-0000-000000000003'::uuid,
  'adoption re-homes the endpoint into the default-models workspace'
);

select throws_ok(
  $$select public.adopt_default_model('00000000-0000-0000-0000-00000000dead')$$,
  'P0001',
  null,
  'adopting a nonexistent endpoint fails loudly, never a silent no-op'
);

-- A world model shared by two endpoints must not move under one of them: the
-- sibling would be stranded in its org while its simulation leaves.
insert into public.world_models (id, org_id, name)
values (
  'aa000000-0000-4000-8000-00000000aaaa',
  '0a000000-0000-4000-8000-00000000aaaa',
  'shared-sim'
);
insert into public.endpoints (id, org_id, world_model_id, name, status, policy)
values
  (
    'e0000000-0000-4000-8000-00000000bbbb',
    '0a000000-0000-4000-8000-00000000aaaa',
    'aa000000-0000-4000-8000-00000000aaaa',
    'shared-a',
    'ready',
    '{"kind": "static"}'::jsonb
  ),
  (
    'e0000000-0000-4000-8000-00000000cccc',
    '0a000000-0000-4000-8000-00000000aaaa',
    'aa000000-0000-4000-8000-00000000aaaa',
    'shared-b',
    'ready',
    '{"kind": "static"}'::jsonb
  );

select throws_ok(
  $$select public.adopt_default_model('e0000000-0000-4000-8000-00000000bbbb')$$,
  'P0001',
  null,
  'adopting one endpoint of a shared world model refuses instead of stranding the sibling'
);

select * from finish();
rollback;
