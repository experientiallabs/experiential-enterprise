-- Two-role follow-up: the credential-bridge definer still gated membership
-- on the retired 'member' role, which silently revoked ordinary users'
-- connector credentials after 20260724100000 collapsed member/viewer into
-- 'user'. Recreate it (create or replace: same row type) with the two-rung
-- list. Caught by explabs_user_connections pgtap tests.

create or replace function public.list_agent_connector_credentials(in_agent_id uuid)
returns table (
  connector_key text,
  provider text,
  user_id uuid,
  value text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  undecryptable_provider text;
begin
  if in_agent_id is null then
    raise exception 'agent_id is required';
  end if;

  -- The connection owner must still be an org member when the token is
  -- released. An enabled connector whose Vault entry no longer decrypts must
  -- fail credential release loudly: silently dropping it would omit a grant
  -- the Connectors tab still shows as enabled.
  select connections.provider
  into undecryptable_provider
  from public.agent_connectors connectors
  join public.user_connections connections
    on connections.id = connectors.connection_id
  where connectors.agent_id = in_agent_id
    and connectors.connector_kind = 'oauth'
    and connections.revoked_at is null
    and exists (
      select 1
      from public.organization_members members
      where members.user_id = connections.user_id
        and members.org_id = connectors.org_id
        and members.role in ('admin', 'user')
    )
    and not exists (
      select 1
      from vault.decrypted_secrets decrypted
      where decrypted.id = connections.vault_secret_id
    )
  limit 1;

  if undecryptable_provider is not null then
    raise exception 'connector % cannot be decrypted; its Vault entry is missing', undecryptable_provider;
  end if;

  update public.user_connections connections
  set last_used_at = now()
  where connections.revoked_at is null
    and connections.id in (
      select connectors.connection_id
      from public.agent_connectors connectors
      where connectors.agent_id = in_agent_id
        and connectors.connector_kind = 'oauth'
        and exists (
          select 1
          from public.organization_members members
          where members.user_id = connections.user_id
            and members.org_id = connectors.org_id
            and members.role in ('admin', 'user')
        )
    );

  return query
    select
      connectors.connector_key,
      connections.provider,
      connections.user_id,
      decrypted.decrypted_secret as value
    from public.agent_connectors connectors
    join public.user_connections connections
      on connections.id = connectors.connection_id
    join vault.decrypted_secrets decrypted
      on decrypted.id = connections.vault_secret_id
    where connectors.agent_id = in_agent_id
      and connectors.connector_kind = 'oauth'
      and connections.revoked_at is null
      and exists (
        select 1
        from public.organization_members members
        where members.user_id = connections.user_id
          and members.org_id = connectors.org_id
          and members.role in ('admin', 'user')
      );
end;
$$;

-- The drop above discarded the original grants; restate the fence.

-- create or replace preserves existing grants; restate the fence anyway so
-- this migration stands alone.
revoke all on function public.list_agent_connector_credentials(uuid)
  from public, anon, authenticated;
grant execute on function public.list_agent_connector_credentials(uuid) to service_role;
