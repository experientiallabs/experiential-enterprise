begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

-- ---------------------------------------------------------------------------
-- E5.3 provider data controls: the curated provider posture matrix
-- (provider_data_controls, seeded for all nine routing providers), the
-- per-org policy table (org_provider_policies) with its allowlist CHECKs and
-- org-delete cascade, and the newest-era privilege posture (RLS on, zero
-- policies, service_role-only DML). All ids are prefixed '79...' so ambient
-- seed data cannot perturb the assertions.

insert into public.organizations (id, slug, name) values
  ('79000000-0000-0000-0000-000000000001', 'dc-test-org-a', 'Data Controls Test Org A'),
  ('79000000-0000-0000-0000-000000000002', 'dc-test-org-b', 'Data Controls Test Org B');

-- ---------------------------------------------------------------------------
-- 1. Table shapes and the curated seed.

select has_table('public', 'provider_data_controls', 'provider_data_controls exists');

select has_table('public', 'org_provider_policies', 'org_provider_policies exists');

select is(
  (select count(*)::int from public.provider_data_controls
    where provider in ('openai', 'anthropic', 'gemini', 'azure_openai', 'bedrock',
                       'fireworks', 'openrouter', 'modal', 'local')),
  9,
  'all nine routing providers carry a curated posture row'
);

select is(
  (select count(*)::int from public.provider_data_controls
    where source_note is null or pg_catalog.char_length(source_note) = 0),
  0,
  'every posture row cites its source'
);

-- Conservative defaults: only providers where data provably stays out of a
-- shared retention store read as zero-data-retention.
select is(
  (select pg_catalog.array_agg(provider order by provider)
     from public.provider_data_controls where zero_data_retention),
  array['bedrock', 'local', 'modal'],
  'only bedrock, local, and modal default to zero-data-retention'
);

select is(
  (select pg_catalog.array_agg(provider order by provider)
     from public.provider_data_controls where not no_training),
  array['openrouter'],
  'only the openrouter aggregator fails the no-training default'
);

-- ---------------------------------------------------------------------------
-- 2. Policy rows and the allowlist shape CHECK.

select lives_ok(
  $$insert into public.org_provider_policies (org_id, require_zdr)
    values ('79000000-0000-0000-0000-000000000001', true)$$,
  'a policy with a null allowlist (all providers) is created'
);

select is(
  (select allowed_providers from public.org_provider_policies
    where org_id = '79000000-0000-0000-0000-000000000001'),
  null::text[],
  'the null allowlist stays null (all providers allowed)'
);

select lives_ok(
  $$update public.org_provider_policies
       set allowed_providers = array['bedrock', 'azure_openai']
     where org_id = '79000000-0000-0000-0000-000000000001'$$,
  'a lowercase non-empty allowlist is accepted'
);

select throws_ok(
  $$update public.org_provider_policies
       set allowed_providers = array[]::text[]
     where org_id = '79000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'an empty allowlist is refused (it would refuse all traffic)'
);

select throws_ok(
  $$update public.org_provider_policies
       set allowed_providers = array['Bedrock']
     where org_id = '79000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'an uppercase provider token is refused'
);

select throws_ok(
  $$update public.org_provider_policies
       set allowed_providers = array['bedrock', null]
     where org_id = '79000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'a null allowlist element is refused'
);

select throws_ok(
  $$insert into public.org_provider_policies (org_id)
    values ('79000000-0000-0000-0000-000000000001')$$,
  '23505',
  null,
  'one policy row per org (org_id is the primary key)'
);

-- ---------------------------------------------------------------------------
-- 3. Deleting the org deletes its policy.

insert into public.org_provider_policies (org_id, require_no_training) values
  ('79000000-0000-0000-0000-000000000002', true);

delete from public.organizations
 where id = '79000000-0000-0000-0000-000000000002';

select is(
  (select count(*)::int from public.org_provider_policies
    where org_id = '79000000-0000-0000-0000-000000000002'),
  0,
  'deleting an org deletes its provider policy'
);

-- ---------------------------------------------------------------------------
-- 4. Privilege posture: RLS on with zero policies; browser roles get nothing;
--    the control API (service_role) holds DML.

set local role authenticated;

select throws_ok(
  $$select count(*) from public.provider_data_controls$$,
  '42501',
  null,
  'authenticated cannot read provider_data_controls'
);

select throws_ok(
  $$select count(*) from public.org_provider_policies$$,
  '42501',
  null,
  'authenticated cannot read org_provider_policies'
);

select throws_ok(
  $$insert into public.provider_data_controls
      (provider, zero_data_retention, no_training, source_note)
    values ('rogue', true, true, 'rogue')$$,
  '42501',
  null,
  'authenticated cannot insert provider_data_controls'
);

select throws_ok(
  $$insert into public.org_provider_policies (org_id)
    values ('79000000-0000-0000-0000-000000000001')$$,
  '42501',
  null,
  'authenticated cannot insert org_provider_policies'
);

reset role;

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('provider_data_controls', 'org_provider_policies')),
  0,
  'the data-control tables carry zero RLS policies (revoke-all posture)'
);

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.provider_data_controls'::regclass),
  'RLS is enabled on provider_data_controls'
);

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.org_provider_policies'::regclass),
  'RLS is enabled on org_provider_policies'
);

select ok(
  has_table_privilege('service_role', 'public.provider_data_controls', 'select'),
  'service role reads the posture matrix'
);

select ok(
  has_table_privilege('service_role', 'public.provider_data_controls', 'update'),
  'service role updates posture rows as provider policies change'
);

select ok(
  has_table_privilege('service_role', 'public.org_provider_policies', 'select'),
  'service role reads org policies'
);

select ok(
  has_table_privilege('service_role', 'public.org_provider_policies', 'insert'),
  'service role creates org policies'
);

select ok(
  has_table_privilege('service_role', 'public.org_provider_policies', 'delete'),
  'service role deletes org policies'
);

select * from finish();

rollback;
