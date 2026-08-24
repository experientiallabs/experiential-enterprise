begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

insert into public.organizations (id, slug, name)
values ('50000000-0000-0000-0000-000000000001', 'secret-org', 'Secret Org');

select lives_ok(
  $$
  select *
  from public.upsert_org_secret(
    '50000000-0000-0000-0000-000000000001',
    'anthropic_api_key',
    'sk-ant-old-secret',
    'test',
    '{"source_env": "TEST"}'
  )
  $$,
  'org secret can be created'
);

create temp table secret_rotation_ids (
  first_vault_secret_id uuid,
  second_vault_secret_id uuid
) on commit drop;

insert into secret_rotation_ids (first_vault_secret_id)
select vault_secret_id
from public.org_secrets
where org_id = '50000000-0000-0000-0000-000000000001'
  and name = 'anthropic_api_key';

select lives_ok(
  $$
  select *
  from public.upsert_org_secret(
    '50000000-0000-0000-0000-000000000001',
    'anthropic_api_key',
    'sk-ant-new-secret',
    'test',
    '{"source_env": "TEST"}'
  )
  $$,
  'org secret can be rotated'
);

update secret_rotation_ids
set second_vault_secret_id = (
  select vault_secret_id
  from public.org_secrets
  where org_id = '50000000-0000-0000-0000-000000000001'
    and name = 'anthropic_api_key'
);

select is(
  (select second_vault_secret_id::text from secret_rotation_ids),
  (select first_vault_secret_id::text from secret_rotation_ids),
  'org secret rotation updates the existing Vault secret row'
);

select is(
  public.get_org_secret('50000000-0000-0000-0000-000000000001', 'anthropic_api_key'),
  'sk-ant-new-secret',
  'org secret rotation decrypts the new value'
);

-- Optimizer-era secret names are gone; the whitelist is provider keys only.
select throws_ok(
  $$
  select *
  from public.upsert_org_secret(
    '50000000-0000-0000-0000-000000000001',
    'github_token',
    'ghp_secret',
    'test',
    '{}'
  )
  $$,
  'P0001',
  'unsupported org secret name: github_token',
  'non-provider secret names are rejected'
);

select * from finish();

rollback;
