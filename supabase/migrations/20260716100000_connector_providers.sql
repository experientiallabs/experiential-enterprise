-- Multi-provider connectors: agent_connectors learns a connector_kind so
-- platform-provided connectors (deployment-level API keys, e.g. the Brave
-- Search connector's BRAVE_API_KEY) can bind an agent with NO backing user
-- connection. OAuth-backed rows keep the connection requirement, now as a
-- kind-aware CHECK instead of NOT NULL.
--
-- user_connections itself needs no change for the new OAuth providers:
-- provider is already a free slug ('google-calendar', 'google-drive',
-- 'gmail', 'slack', 'notion' all pass the existing CHECK), and the Vault
-- payload is an opaque string — Google connections store a JSON
-- {access_token, refresh_token, expires_at} document, comfortably inside
-- the 8192-char cap, while non-expiring providers keep bare token strings.

alter table public.agent_connectors
  add column connector_kind text not null default 'oauth'
    check (connector_kind in ('oauth', 'platform'));

-- The default exists only to backfill pre-existing oauth rows; writers must
-- say what they are from here on.
alter table public.agent_connectors
  alter column connector_kind drop default;

alter table public.agent_connectors
  alter column connection_id drop not null;

-- kind <-> connection binding is one invariant: oauth rows are always backed
-- by a user connection, platform rows never are.
alter table public.agent_connectors
  add constraint agent_connectors_kind_connection check (
    (connector_kind = 'oauth' and connection_id is not null)
    or (connector_kind = 'platform' and connection_id is null)
  );

-- Recreate the credential-release RPC carrying every prior term forward (the
-- connection owner must still be an org member with role admin/member; an
-- undecryptable Vault entry fails loudly; releases stamp last_used_at) and
-- adding the kind fence: only oauth-kind rows release user credentials.
-- Platform-kind rows carry no Vault-backed secret — the trusted runtime
-- resolves their deployment env key (e.g. BRAVE_API_KEY) itself, reading the
-- enabled set from agent_connectors directly.
--
-- The returned value is the RAW Vault payload — for Google-style providers a
-- JSON {access_token, refresh_token, expires_at} document whose access token
-- dies in about an hour — so this RPC is never handed to the runtime
-- directly. The web tier's releaseAgentConnectorCredentials
-- (apps/web/lib/agent-connectors-server.ts) is the release path: it refreshes
-- expiring payloads (persisting via refresh_user_connection_secret below) and
-- releases only usable access tokens. The new user_id column is what keys
-- that refresh; it is server-internal (service_role-only) and never reaches
-- browsers. The return-shape change forces a drop first: create or replace
-- cannot alter a function's row type.
drop function public.list_agent_connector_credentials(uuid);

create function public.list_agent_connector_credentials(in_agent_id uuid)
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
        and members.role in ('admin', 'member')
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
            and members.role in ('admin', 'member')
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
          and members.role in ('admin', 'member')
      );
end;
$$;

-- The drop above discarded the original grants; restate the fence.
revoke all on function public.list_agent_connector_credentials(uuid)
  from public, anon, authenticated;

grant execute on function public.list_agent_connector_credentials(uuid)
  to service_role;

-- Persist a refreshed token for one EXISTING active connection, in place.
-- Deliberately UPDATE-ONLY: upsert_user_connection INSERTS a brand-new
-- active connection when no active (user, provider) row exists, so a token
-- refresh completing after a disconnect would silently resurrect the
-- withdrawn grant with a live credential. Keyed on the exact connection id
-- the caller read the payload from, this also refuses to write into a
-- replacement connection minted by a mid-refresh reconnect (possibly as a
-- different provider account). Returns false — persisting nothing — in both
-- cases. Account identity is untouched: only the Vault value and the
-- updated_* audit columns change.
create function public.refresh_user_connection_secret(
  in_connection_id uuid,
  in_secret text,
  in_updated_by text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor text := nullif(btrim(in_updated_by), '');
  target_user uuid;
  target_provider text;
  target_vault uuid;
  vault_name text;
begin
  if in_connection_id is null then
    raise exception 'connection_id is required';
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'connection token is required';
  end if;
  if length(in_secret) > 8192 then
    raise exception 'connection token exceeds the 8192 character limit';
  end if;

  -- Connection rows are never deleted (disconnect soft-revokes), so the id
  -- resolves the (user, provider) advisory-lock key even for a row revoked
  -- moments ago.
  select connections.user_id, connections.provider
  into target_user, target_provider
  from public.user_connections connections
  where connections.id = in_connection_id
  limit 1;

  if target_user is null then
    return false;
  end if;

  -- Same lock as upsert/revoke: the active re-check below is authoritative
  -- only after concurrent disconnects/reconnects for this (user, provider)
  -- have committed.
  perform pg_advisory_xact_lock(
    hashtextextended('user_connection:' || target_user::text || ':' || target_provider, 0)
  );

  select connections.vault_secret_id
  into target_vault
  from public.user_connections connections
  where connections.id = in_connection_id
    and connections.revoked_at is null
  limit 1;

  if target_vault is null then
    return false;
  end if;

  -- Mirror upsert_user_connection's rotation: Vault names are unique, so
  -- every write gets a fresh uuid suffix; the metadata row keeps pointing at
  -- the same Vault secret id.
  vault_name := format(
    'user:%s:connection:%s:%s',
    target_user::text,
    target_provider,
    gen_random_uuid()::text
  );
  perform vault.update_secret(target_vault, in_secret, vault_name, target_provider);

  update public.user_connections
  set
    updated_by = actor,
    updated_at = now()
  where user_connections.id = in_connection_id;

  return true;
end;
$$;

revoke all on function public.refresh_user_connection_secret(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.refresh_user_connection_secret(uuid, text, text)
  to service_role;
