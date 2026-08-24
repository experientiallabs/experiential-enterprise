begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

insert into public.organizations (id, slug, name)
values ('61000000-0000-0000-0000-000000000001', 'pgtap-key-status-tenant', 'pgTAP Key Status Tenant');

-- ---------------------------------------------------------------------------
-- A fresh connection starts unchecked with no detail, timestamp, or source.

select public.upsert_provider_connection(
  '61000000-0000-0000-0000-000000000001',
  'anthropic',
  '{}'::jsonb,
  'sk-ant-pgtap-secret-1234',
  null
);

select is(
  (
    select status
    from public.provider_connections
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'
  ),
  'unchecked',
  'a freshly connected key starts unchecked'
);

select ok(
  (
    select status_detail is null and status_checked_at is null and status_source is null
    from public.provider_connections
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'
  ),
  'a fresh connection carries no stale detail, timestamp, or source'
);

-- ---------------------------------------------------------------------------
-- Every canonical status value is admitted; anything else is refused.
-- model_not_deployed is deliberately NOT a status: it is a per-model fact
-- under status_detail.models while the key itself stays valid.

update public.provider_connections
set status = 'valid',
    status_detail = '{"remediation": "pgtap"}'::jsonb,
    status_checked_at = now(),
    status_source = 'hookup_check'
where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic';

select is(
  (
    select count(*)::int
    from public.provider_connections
    where org_id = '61000000-0000-0000-0000-000000000001'
      and provider = 'anthropic'
      and status = 'valid'
      and status_source = 'hookup_check'
  ),
  1,
  'the hookup check can persist a verified status with its source'
);

select lives_ok(
  $$update public.provider_connections
    set status = 'invalid'
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'$$,
  'invalid is an admitted status'
);

select lives_ok(
  $$update public.provider_connections
    set status = 'rate_limited', status_source = 'traffic'
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'$$,
  'rate_limited is an admitted status and traffic an admitted source'
);

select lives_ok(
  $$update public.provider_connections
    set status = 'quota_exhausted'
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'$$,
  'quota_exhausted is an admitted status'
);

select lives_ok(
  $$update public.provider_connections
    set status = 'provider_error'
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'$$,
  'provider_error is an admitted status'
);

select throws_ok(
  $$update public.provider_connections
    set status = 'model_not_deployed'
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'$$,
  '23514',
  null,
  'model_not_deployed is a per-model fact in status_detail, never a key status'
);

select throws_ok(
  $$update public.provider_connections
    set status_source = 'manual_recheck'
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'$$,
  '23514',
  null,
  'only the hookup check and traffic may write status (no manual rechecks exist)'
);

-- ---------------------------------------------------------------------------
-- Rotating a key resets the verdict: the new key never wears the old key's
-- status while its own hookup check runs.

update public.provider_connections
set status = 'invalid',
    status_detail = '{"remediation": "stale"}'::jsonb,
    status_checked_at = now(),
    status_source = 'traffic'
where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic';

select public.upsert_provider_connection(
  '61000000-0000-0000-0000-000000000001',
  'anthropic',
  '{}'::jsonb,
  'sk-ant-pgtap-rotated-5678',
  null
);

select ok(
  (
    select status = 'unchecked'
      and status_detail is null
      and status_checked_at is null
      and status_source is null
    from public.provider_connections
    where org_id = '61000000-0000-0000-0000-000000000001' and provider = 'anthropic'
  ),
  'rotation resets status, detail, timestamp, and source to unchecked'
);

-- ---------------------------------------------------------------------------
-- The widened provider set: fireworks and modal connect as full tiles.

select lives_ok(
  $$select public.upsert_provider_connection(
      '61000000-0000-0000-0000-000000000001',
      'fireworks',
      '{"account_id": "pgtap-account"}'::jsonb,
      'fw_pgtap_secret_key',
      null
    )$$,
  'fireworks is an admitted connection provider'
);

select lives_ok(
  $$select public.upsert_provider_connection(
      '61000000-0000-0000-0000-000000000001',
      'modal',
      '{}'::jsonb,
      '{"token_id": "ak-pgtap", "token_secret": "as-pgtap"}',
      null
    )$$,
  'modal is an admitted connection provider (token pair as one JSON secret)'
);

select throws_ok(
  $$insert into public.provider_connections (org_id, provider, vault_secret_id)
    values (
      '61000000-0000-0000-0000-000000000001',
      'cohere',
      gen_random_uuid()
    )$$,
  '23514',
  null,
  'providers outside the widened set stay refused'
);

select * from finish();
rollback;
