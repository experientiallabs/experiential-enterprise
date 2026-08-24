begin;

create extension if not exists pgtap with schema extensions;

select plan(29);

insert into public.organizations (id, slug, name)
values ('52000000-0000-0000-0000-000000000001', 'connection-org', 'Connection Org');

insert into public.world_models (id, org_id, name, status)
values (
  '52000000-0000-0000-0000-000000000003',
  '52000000-0000-0000-0000-000000000001',
  'connection-wm',
  'ready'
);

insert into public.agents (id, org_id, world_model_id, name, agent_provider, agent_model)
values (
  '52000000-0000-0000-0000-000000000004',
  '52000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000003',
  'connection-agent',
  'bedrock',
  'test-model'
);

-- The connecting user is an org member; the token-release fence requires it.
insert into public.organization_members (org_id, user_id, role)
values (
  '52000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-00000000000a',
  'user'
);

-- user_id has no FK (GoTrue owns auth.users), so a fixed uuid suffices.
select lives_ok(
  $$
  select *
  from public.upsert_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'github',
    'gho_first_token',
    '1234',
    'kfallah',
    'test'
  )
  $$,
  'account connection can be created'
);

create temp table connection_rotation_ids (
  first_vault_secret_id uuid,
  second_vault_secret_id uuid
) on commit drop;

insert into connection_rotation_ids (first_vault_secret_id)
select vault_secret_id
from public.user_connections
where user_id = '52000000-0000-0000-0000-00000000000a'
  and provider = 'github';

select lives_ok(
  $$
  select *
  from public.upsert_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'github',
    'gho_second_token',
    '1234',
    'kfallah',
    'test'
  )
  $$,
  'reconnecting replaces the token in place'
);

update connection_rotation_ids
set second_vault_secret_id = (
  select vault_secret_id
  from public.user_connections
  where user_id = '52000000-0000-0000-0000-00000000000a'
    and provider = 'github'
    and revoked_at is null
);

select is(
  (select second_vault_secret_id::text from connection_rotation_ids),
  (select first_vault_secret_id::text from connection_rotation_ids),
  'reconnect updates the existing Vault secret row'
);

select is(
  (
    select account_handle
    from public.list_user_connections('52000000-0000-0000-0000-00000000000a')
  ),
  'kfallah',
  'connection metadata lists the provider identity'
);

-- The agent opts in by reference.
insert into public.agent_connectors
  (agent_id, org_id, connector_key, connector_kind, connection_id, created_by)
select
  '52000000-0000-0000-0000-000000000004',
  '52000000-0000-0000-0000-000000000001',
  'github',
  'oauth',
  connections.id,
  'test'
from public.user_connections connections
where connections.user_id = '52000000-0000-0000-0000-00000000000a'
  and connections.provider = 'github'
  and connections.revoked_at is null;

select results_eq(
  $$
  select connector_key, provider, user_id, value
  from public.list_agent_connector_credentials('52000000-0000-0000-0000-000000000004')
  $$,
  $$
  values (
    'github'::text,
    'github'::text,
    '52000000-0000-0000-0000-00000000000a'::uuid,
    'gho_second_token'::text
  )
  $$,
  'enabled connectors expose typed credentials plus their owner to the release path'
);

select is(
  (
    select last_used_at is not null
    from public.user_connections
    where user_id = '52000000-0000-0000-0000-00000000000a'
      and provider = 'github'
      and revoked_at is null
  ),
  true,
  'credential listing stamps last_used_at'
);

-- Offboarding fails closed at token-release time: with the two-rung role
-- ladder there is no sub-member tier to demote to, so offboarding IS
-- removing the membership, and that stops the token flowing.
delete from public.organization_members
where org_id = '52000000-0000-0000-0000-000000000001'
  and user_id = '52000000-0000-0000-0000-00000000000a';

select is(
  (
    select count(*)::integer
    from public.list_agent_connector_credentials('52000000-0000-0000-0000-000000000004')
  ),
  0,
  'a removed connection owner''s token stops flowing to the connector host'
);

insert into public.organization_members (org_id, user_id, role)
values (
  '52000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-00000000000a',
  'user'
);

select is(
  (
    select count(*)::integer
    from public.list_agent_connector_credentials('52000000-0000-0000-0000-000000000004')
  ),
  1,
  'restoring membership restores the grant'
);

select is(
  public.revoke_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'github',
    'test',
    'test cleanup'
  ),
  true,
  'active connection can be disconnected'
);

select is(
  (
    select count(*)::integer
    from public.agent_connectors
    where agent_id = '52000000-0000-0000-0000-000000000004'
  ),
  0,
  'disconnecting removes every agent opt-in in the same transaction'
);

-- The platform minted the credential, so it does not outlive the grant.
select is(
  (
    select count(*)::integer
    from vault.secrets
    where id = (select second_vault_secret_id from connection_rotation_ids)
  ),
  0,
  'disconnecting destroys the Vault secret'
);

select is(
  (
    select count(*)::integer
    from public.list_agent_connector_credentials('52000000-0000-0000-0000-000000000004')
  ),
  0,
  'the connector host receives nothing after disconnect'
);

select is(
  public.revoke_user_connection('52000000-0000-0000-0000-00000000000a', 'github', 'test'),
  false,
  'disconnecting twice reports no match'
);

-- Reconnect after disconnect: the partial unique index frees the slot.
select lives_ok(
  $$
  select *
  from public.upsert_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'github',
    'gho_third_token',
    '1234',
    'kfallah',
    'test'
  )
  $$,
  'reconnect after disconnect creates a fresh active connection'
);

-- New providers ride the same slug + opaque-secret contract: expiring
-- providers (Google) store a JSON refresh payload, and the RPCs stay
-- provider-agnostic.
select lives_ok(
  $$
  select *
  from public.upsert_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'google-calendar',
    '{"access_token":"ya29.test","refresh_token":"1//refresh","expires_at":"2027-01-01T00:00:00Z"}',
    'google-sub-1',
    'kion@example.com',
    'test'
  )
  $$,
  'a google-calendar connection stores a JSON token payload'
);

select results_eq(
  $$
  select provider
  from public.list_user_connections('52000000-0000-0000-0000-00000000000a')
  $$,
  $$ values ('github'::text), ('google-calendar'::text) $$,
  'connections list every active provider in provider order'
);

-- Platform-kind connectors bind against the deployment credential: no user
-- connection exists, and the kind/connection CHECK enforces both directions.
select lives_ok(
  $$
  insert into public.agent_connectors
    (agent_id, org_id, connector_key, connector_kind, connection_id, created_by)
  values (
    '52000000-0000-0000-0000-000000000004',
    '52000000-0000-0000-0000-000000000001',
    'brave',
    'platform',
    null,
    'test'
  )
  $$,
  'a platform-kind connector binds without a user connection'
);

select throws_ok(
  $$
  insert into public.agent_connectors
    (agent_id, org_id, connector_key, connector_kind, connection_id, created_by)
  select
    '52000000-0000-0000-0000-000000000004',
    '52000000-0000-0000-0000-000000000001',
    'platform-with-connection',
    'platform',
    connections.id,
    'test'
  from public.user_connections connections
  where connections.user_id = '52000000-0000-0000-0000-00000000000a'
    and connections.provider = 'google-calendar'
    and connections.revoked_at is null
  $$,
  '23514',
  null,
  'a platform-kind connector must not carry a connection'
);

select throws_ok(
  $$
  insert into public.agent_connectors
    (agent_id, org_id, connector_key, connector_kind, connection_id, created_by)
  values (
    '52000000-0000-0000-0000-000000000004',
    '52000000-0000-0000-0000-000000000001',
    'gmail',
    'oauth',
    null,
    'test'
  )
  $$,
  '23514',
  null,
  'an oauth-kind connector requires a backing connection'
);

-- Platform rows carry no Vault-backed secret: the trusted runtime resolves
-- the deployment env key itself, so credential release returns nothing for
-- them (the agent's only rows right now are the brave binding above).
select is(
  (
    select count(*)::integer
    from public.list_agent_connector_credentials('52000000-0000-0000-0000-000000000004')
  ),
  0,
  'platform bindings release no vault credential'
);

-- A connection whose owner is no org member at all stays fenced: the opt-in
-- row can exist, but the token never flows.
select lives_ok(
  $$
  select *
  from public.upsert_user_connection(
    '52000000-0000-0000-0000-00000000000b',
    'slack',
    'xoxp-foreign-token',
    'U999',
    'Foreign Workspace',
    'test'
  )
  $$,
  'a non-member user can still hold an account connection'
);

insert into public.agent_connectors
  (agent_id, org_id, connector_key, connector_kind, connection_id, created_by)
select
  '52000000-0000-0000-0000-000000000004',
  '52000000-0000-0000-0000-000000000001',
  'slack',
  'oauth',
  connections.id,
  'test'
from public.user_connections connections
where connections.user_id = '52000000-0000-0000-0000-00000000000b'
  and connections.provider = 'slack'
  and connections.revoked_at is null;

select is(
  (
    select count(*)::integer
    from public.list_agent_connector_credentials('52000000-0000-0000-0000-000000000004')
  ),
  0,
  'a non-member owner''s connection releases nothing'
);

-- Refreshing an expiring token persists UPDATE-ONLY: in place while the
-- connection is active, refused (never inserting) once it is revoked — a
-- refresh completing after a disconnect must not resurrect the withdrawn
-- grant, and a stale connection id must never write into a replacement row.
create temp table refresh_fence_ids (
  connection_id uuid,
  vault_secret_id uuid
) on commit drop;

select lives_ok(
  $$
  select *
  from public.upsert_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'google-drive',
    '{"access_token":"ya29.old","refresh_token":"1//refresh","expires_at":"2026-01-01T00:00:00Z"}',
    'google-sub-1',
    'kion@example.com',
    'test'
  )
  $$,
  'an expiring google-drive connection stores its refresh payload'
);

insert into refresh_fence_ids (connection_id, vault_secret_id)
select id, vault_secret_id
from public.user_connections
where user_id = '52000000-0000-0000-0000-00000000000a'
  and provider = 'google-drive'
  and revoked_at is null;

select is(
  public.refresh_user_connection_secret(
    (select connection_id from refresh_fence_ids),
    '{"access_token":"ya29.rotated","refresh_token":"1//refresh","expires_at":"2027-01-01T00:00:00Z"}',
    'test'
  ),
  true,
  'an active connection accepts a refreshed payload'
);

select is(
  (
    select decrypted.decrypted_secret
    from vault.decrypted_secrets decrypted
    where decrypted.id = (select vault_secret_id from refresh_fence_ids)
  ),
  '{"access_token":"ya29.rotated","refresh_token":"1//refresh","expires_at":"2027-01-01T00:00:00Z"}',
  'the refresh updates the existing Vault secret in place'
);

select is(
  public.revoke_user_connection(
    '52000000-0000-0000-0000-00000000000a',
    'google-drive',
    'test',
    'disconnect racing an in-flight refresh'
  ),
  true,
  'the google-drive connection disconnects while a refresh is in flight'
);

select is(
  public.refresh_user_connection_secret(
    (select connection_id from refresh_fence_ids),
    '{"access_token":"ya29.zombie","refresh_token":"1//refresh","expires_at":"2027-01-01T00:00:00Z"}',
    'test'
  ),
  false,
  'a refresh landing after disconnect is refused'
);

select is(
  (
    select count(*)::integer
    from public.user_connections
    where user_id = '52000000-0000-0000-0000-00000000000a'
      and provider = 'google-drive'
      and revoked_at is null
  ),
  0,
  'the refused refresh never resurrects the connection'
);

select is(
  public.refresh_user_connection_secret(gen_random_uuid(), 'ya29.orphan', 'test'),
  false,
  'refreshing an unknown connection id is refused'
);

select * from finish();

rollback;
