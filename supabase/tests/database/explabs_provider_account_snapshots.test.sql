begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- Fixture graph: one org with a member, one provider connection.
insert into public.organizations (id, slug, name)
values ('62000000-0000-0000-0000-000000000001', 'pgtap-snapshots-tenant', 'pgTAP Snapshots Tenant');

insert into public.organization_members (org_id, user_id, role)
values (
  '62000000-0000-0000-0000-000000000001',
  '62000000-0000-0000-0000-000000000099',
  'user'
);

select public.upsert_provider_connection(
  '62000000-0000-0000-0000-000000000001',
  'openrouter',
  '{}'::jsonb,
  'sk-or-pgtap-secret-1234',
  null
);

-- ---------------------------------------------------------------------------
-- Snapshots record readings; sources are the labeled three and nothing else.

insert into public.provider_account_snapshots (
  org_id, connection_id, provider, spend_usd, credits_remaining_usd, usage_limit_usd, source, detail
)
select
  connections.org_id,
  connections.id,
  connections.provider,
  27.41,
  82.91,
  100,
  'provider_api',
  '{"limit_reset": "daily"}'::jsonb
from public.provider_connections connections
where connections.org_id = '62000000-0000-0000-0000-000000000001';

select is(
  (
    select count(*)::int
    from public.provider_account_snapshots
    where org_id = '62000000-0000-0000-0000-000000000001'
  ),
  1,
  'a provider reading lands as one snapshot row'
);

select lives_ok(
  $$insert into public.provider_account_snapshots (org_id, connection_id, provider, credits_remaining_usd, source)
    select org_id, id, provider, 50, 'self_reported'
    from public.provider_connections
    where org_id = '62000000-0000-0000-0000-000000000001'$$,
  'self_reported is an admitted source (the declared-balance gauge)'
);

select lives_ok(
  $$insert into public.provider_account_snapshots (org_id, connection_id, provider, spend_usd, source)
    select org_id, id, provider, 79.21, 'our_side'
    from public.provider_connections
    where org_id = '62000000-0000-0000-0000-000000000001'$$,
  'our_side is an admitted source (AWS Cost Explorer)'
);

select throws_ok(
  $$insert into public.provider_account_snapshots (org_id, connection_id, provider, source)
    select org_id, id, provider, 'guessed'
    from public.provider_connections
    where org_id = '62000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'sources outside the labeled three are refused'
);

select throws_ok(
  $$insert into public.provider_account_snapshots (org_id, connection_id, provider, spend_usd, source)
    select org_id, id, provider, -1, 'provider_api'
    from public.provider_connections
    where org_id = '62000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'negative dollar readings are refused'
);

-- ---------------------------------------------------------------------------
-- RLS: org members read their org's history; nobody else reads it and
-- authenticated users have no write path (service role only).

select set_config('request.jwt.claim.sub', '62000000-0000-0000-0000-000000000099', true);
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.provider_account_snapshots
    where org_id = '62000000-0000-0000-0000-000000000001'
  ),
  3,
  'an org member reads the org''s snapshot history'
);

select throws_ok(
  $$insert into public.provider_account_snapshots (org_id, connection_id, provider, source)
    select org_id, id, provider, 'provider_api'
    from public.provider_connections
    where org_id = '62000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'authenticated members cannot write snapshots (service role only)'
);

reset role;

select set_config('request.jwt.claim.sub', '62000000-0000-0000-0000-000000000098', true);
set local role authenticated;

select is(
  (
    select count(*)::int
    from public.provider_account_snapshots
    where org_id = '62000000-0000-0000-0000-000000000001'
  ),
  0,
  'non-members cannot read another org''s snapshots'
);

reset role;

-- ---------------------------------------------------------------------------
-- Disconnecting the provider cascades its history: a snapshot without its
-- connection would be an unattributable number.

select is(
  public.delete_provider_connection('62000000-0000-0000-0000-000000000001', 'openrouter'),
  true,
  'the fixture connection disconnects'
);

select is(
  (
    select count(*)::int
    from public.provider_account_snapshots
    where org_id = '62000000-0000-0000-0000-000000000001'
  ),
  0,
  'snapshots cascade with their connection'
);

-- Deleting the org would cascade the same way through org_id.
select has_index(
  'public',
  'provider_account_snapshots',
  'provider_account_snapshots_connection_taken_idx',
  'the latest-reading-per-connection query is indexed'
);

-- The web loaders read the latest reading one (org, provider) at a time, so
-- that lookup gets its own composite index rather than filtering provider off
-- the org-wide history index.
select has_index(
  'public',
  'provider_account_snapshots',
  'provider_account_snapshots_org_provider_taken_idx',
  'the latest-reading-per-(org, provider) query is indexed'
);

select * from finish();
rollback;
