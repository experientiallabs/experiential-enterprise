begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

insert into public.organizations (id, slug, name)
values ('51000000-0000-0000-0000-000000000001', 'agent-secret-org', 'Agent Secret Org');

insert into public.world_models (id, org_id, name, status)
values (
  '51000000-0000-0000-0000-000000000003',
  '51000000-0000-0000-0000-000000000001',
  'agent-secret-wm',
  'ready'
);

insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  '51000000-0000-0000-0000-000000000004',
  '51000000-0000-0000-0000-000000000001',
  '51000000-0000-0000-0000-000000000003',
  'agent-secret-agent',
  'bedrock',
  'test-model'
);

-- Lowercase input is normalized to the env-var convention.
select lives_ok(
  $$
  select *
  from public.upsert_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    'github_token',
    'ghp_first_value',
    'test',
    '{"source": "test"}'
  )
  $$,
  'agent secret can be created'
);

select is(
  (
    select name
    from public.agent_secrets
    where agent_id = '51000000-0000-0000-0000-000000000004'
  ),
  'GITHUB_TOKEN',
  'agent secret names are uppercased to env-var form'
);

create temp table agent_secret_rotation_ids (
  first_vault_secret_id uuid,
  second_vault_secret_id uuid
) on commit drop;

insert into agent_secret_rotation_ids (first_vault_secret_id)
select vault_secret_id
from public.agent_secrets
where agent_id = '51000000-0000-0000-0000-000000000004'
  and name = 'GITHUB_TOKEN';

select lives_ok(
  $$
  select *
  from public.upsert_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    'GITHUB_TOKEN',
    'ghp_second_value',
    'test'
  )
  $$,
  'agent secret can be rotated'
);

update agent_secret_rotation_ids
set second_vault_secret_id = (
  select vault_secret_id
  from public.agent_secrets
  where agent_id = '51000000-0000-0000-0000-000000000004'
    and name = 'GITHUB_TOKEN'
);

select is(
  (select second_vault_secret_id::text from agent_secret_rotation_ids),
  (select first_vault_secret_id::text from agent_secret_rotation_ids),
  'agent secret rotation updates the existing Vault secret row'
);

select results_eq(
  $$
  select name, value
  from public.list_agent_secrets('51000000-0000-0000-0000-000000000004')
  $$,
  $$ values ('GITHUB_TOKEN'::text, 'ghp_second_value'::text) $$,
  'list_agent_secrets decrypts the rotated value'
);

select is(
  (
    select last4
    from public.list_agent_secret_metadata('51000000-0000-0000-0000-000000000004')
  ),
  'alue',
  'metadata exposes the trailing four characters only'
);

select throws_ok(
  $$
  select *
  from public.upsert_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    '9BAD_NAME',
    'value',
    'test'
  )
  $$,
  'P0001',
  'secret name must be an environment-variable-style identifier (A-Z, 0-9, _; max 64 chars): 9BAD_NAME',
  'names must start with a letter'
);

select throws_ok(
  $$
  select *
  from public.upsert_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    'EXPLABS_API_KEY',
    'value',
    'test'
  )
  $$,
  'P0001',
  'secret name uses a reserved prefix: EXPLABS_API_KEY',
  'reserved infra prefixes are rejected'
);

select is(
  public.revoke_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    'github_token',
    'test',
    'test cleanup'
  ),
  true,
  'active agent secret can be revoked'
);

select is(
  (
    select count(*)::integer
    from vault.secrets
    where id = (select first_vault_secret_id from agent_secret_rotation_ids)
  ),
  0,
  'revoking an agent secret destroys its Vault value'
);

select is(
  public.revoke_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    'GITHUB_TOKEN',
    'test'
  ),
  false,
  'revoking an already-revoked secret reports no match'
);

select is(
  (
    select count(*)::integer
    from public.list_agent_secret_metadata('51000000-0000-0000-0000-000000000004')
  ),
  0,
  'revoked secrets disappear from metadata and credential listings'
);

-- right(value, 4) of a short value IS the value, so no hint is stored.
select lives_ok(
  $$
  select *
  from public.upsert_agent_secret(
    '51000000-0000-0000-0000-000000000004',
    'SHORT_PIN',
    '1234',
    'test'
  )
  $$,
  'short secrets can be stored'
);

select is(
  (
    select last4
    from public.agent_secrets
    where agent_id = '51000000-0000-0000-0000-000000000004'
      and name = 'SHORT_PIN'
  ),
  null::text,
  'values shorter than eight characters keep no last4 hint'
);

-- An active row whose Vault entry vanished must fail credential release loudly
-- instead of silently omitting a capability the control plane still shows.
delete from vault.secrets
where id = (
  select vault_secret_id
  from public.agent_secrets
  where agent_id = '51000000-0000-0000-0000-000000000004'
    and name = 'SHORT_PIN'
);

select throws_ok(
  $$
  select *
  from public.list_agent_secrets('51000000-0000-0000-0000-000000000004')
  $$,
  'P0001',
  'agent secret SHORT_PIN cannot be decrypted; its Vault entry is missing',
  'undecryptable active secrets fail loudly instead of vanishing'
);

select * from finish();

rollback;
