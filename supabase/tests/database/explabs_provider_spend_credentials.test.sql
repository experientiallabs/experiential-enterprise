begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

insert into public.organizations (id, slug, name)
values ('63000000-0000-0000-0000-000000000001', 'pgtap-spend-key-tenant', 'pgTAP Spend Key Tenant');

-- ---------------------------------------------------------------------------
-- The admin key is an add-on to an existing connection, never its own row.

select throws_ok(
  $$select public.set_provider_connection_spend_credential(
      '63000000-0000-0000-0000-000000000001',
      'anthropic',
      'sk-ant-admin01-pgtap-secret',
      null
    )$$,
  null,
  'provider connection not found for org 63000000-0000-0000-0000-000000000001 provider anthropic',
  'an admin key cannot be stored before the provider is connected'
);

select public.upsert_provider_connection(
  '63000000-0000-0000-0000-000000000001',
  'anthropic',
  '{}'::jsonb,
  'sk-ant-api03-pgtap-main-key',
  null
);

select throws_ok(
  $$select public.release_provider_connection_spend_credential(
      (select id from public.provider_connections
       where org_id = '63000000-0000-0000-0000-000000000001' and provider = 'anthropic')
    )$$,
  null,
  null,
  'releasing a spend credential that was never stored fails loudly'
);

-- ---------------------------------------------------------------------------
-- Store, release, rotate: the Vault round-trip for the second secret.

select is(
  (
    select credentials.spend_credential_last4
    from public.set_provider_connection_spend_credential(
      '63000000-0000-0000-0000-000000000001',
      'anthropic',
      'sk-ant-admin01-pgtap-secret',
      null
    ) credentials
  ),
  'cret',
  'storing the admin key returns its last four characters'
);

select is(
  (
    select credential
    from public.release_provider_connection_spend_credential(
      (select id from public.provider_connections
       where org_id = '63000000-0000-0000-0000-000000000001' and provider = 'anthropic')
    )
  ),
  'sk-ant-admin01-pgtap-secret',
  'the release RPC decrypts the stored admin key'
);

select public.set_provider_connection_spend_credential(
  '63000000-0000-0000-0000-000000000001',
  'anthropic',
  'sk-ant-admin01-rotated-9876',
  null
);

select is(
  (
    select credential
    from public.release_provider_connection_spend_credential(
      (select id from public.provider_connections
       where org_id = '63000000-0000-0000-0000-000000000001' and provider = 'anthropic')
    )
  ),
  'sk-ant-admin01-rotated-9876',
  'storing again rotates the Vault secret in place'
);

select is(
  (
    select count(*)::int
    from public.provider_connections
    where org_id = '63000000-0000-0000-0000-000000000001' and provider = 'anthropic'
  ),
  1,
  'the admin key rides the existing connection row'
);

select throws_ok(
  $$select public.set_provider_connection_spend_credential(
      '63000000-0000-0000-0000-000000000001',
      'anthropic',
      'short',
      null
    )$$,
  null,
  'provider spend credential is too short to be a real API key',
  'a secret short enough to leak through last4 is refused'
);

-- ---------------------------------------------------------------------------
-- Rotating the MAIN key keeps the admin key: the two credentials are
-- independent (the hookup check re-verifies both in the same pass).

select public.upsert_provider_connection(
  '63000000-0000-0000-0000-000000000001',
  'anthropic',
  '{}'::jsonb,
  'sk-ant-api03-pgtap-rotated',
  null
);

select is(
  (
    select spend_credential_last4
    from public.provider_connections
    where org_id = '63000000-0000-0000-0000-000000000001' and provider = 'anthropic'
  ),
  '9876',
  'rotating the main key leaves the stored admin key in place'
);

-- ---------------------------------------------------------------------------
-- Disconnect drops BOTH Vault secrets with the row.

select is(
  (
    select count(*)::int from vault.secrets
    where name like 'org:63000000-0000-0000-0000-000000000001:provider-connection%'
  ),
  2,
  'the connection holds two Vault secrets before disconnect'
);

select public.delete_provider_connection('63000000-0000-0000-0000-000000000001', 'anthropic');

select is(
  (
    select count(*)::int from vault.secrets
    where name like 'org:63000000-0000-0000-0000-000000000001:provider-connection%'
  ),
  0,
  'disconnect drops the main and admin Vault secrets together'
);

select * from finish();
rollback;
