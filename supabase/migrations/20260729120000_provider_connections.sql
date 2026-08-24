-- Org-scoped model-provider credentials (BYOK): an org connects its own
-- OpenAI / Anthropic / Azure OpenAI account, and that org's endpoints serve
-- those providers' models through the org's key instead of (or in the absence
-- of) platform credentials.
--
-- Sibling of trace_connections rather than more kinds on it: the kind
-- namespace there names TRACE SOURCES (an "openai" trace exporter would
-- collide), the consumers differ (serving and optimization, not ingest), and
-- the release RPC stamps a different table's last_used_at. The Vault shape is
-- identical on purpose: non-secret config on the row (Azure's resource
-- endpoint and deployment names), the credential only ever in Vault, entering
-- through the upsert RPC and leaving only through the release RPC, both
-- service-role.

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (
    provider in ('openai', 'anthropic', 'azure_openai', 'openrouter')
  ),
  -- Non-secret provider config. Azure carries {endpoint, deployments: {model_type: name}};
  -- OpenAI and Anthropic need nothing beside the key.
  config jsonb not null default '{}'::jsonb,
  vault_secret_id uuid not null,
  credential_last4 text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (org_id, provider)
);

create index provider_connections_org_id_idx on public.provider_connections (org_id);

alter table public.provider_connections enable row level security;

create policy provider_connections_select_member
  on public.provider_connections
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- Create or rotate one org's provider credential (same pattern as
-- upsert_trace_connection; rotation updates the Vault secret in place).
create function public.upsert_provider_connection(
  in_org_id uuid,
  in_provider text,
  in_config jsonb,
  in_secret text,
  in_actor text default null
)
returns table (
  id uuid,
  org_id uuid,
  provider text,
  config jsonb,
  credential_last4 text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  actor text := nullif(btrim(in_actor), '');
  existing_id uuid;
  existing_vault uuid;
  vault_secret uuid;
  vault_name text;
begin
  if normalized_provider is null then
    raise exception 'provider is required';
  end if;
  if in_secret is null or length(in_secret) = 0 then
    raise exception 'provider credential is required';
  end if;
  -- credential_last4 is member-readable; a short secret would land in it
  -- whole. Real provider keys are far longer than this floor.
  if length(in_secret) < 12 then
    raise exception 'provider credential is too short to be a real API key';
  end if;
  if not exists (select 1 from public.organizations where organizations.id = in_org_id) then
    raise exception 'organization not found: %', in_org_id;
  end if;

  select connections.id, connections.vault_secret_id
  into existing_id, existing_vault
  from public.provider_connections connections
  where connections.org_id = in_org_id
    and connections.provider = normalized_provider
  limit 1;

  vault_name := format(
    'org:%s:provider-connection:%s:%s',
    in_org_id::text,
    normalized_provider,
    gen_random_uuid()::text
  );

  if existing_id is null then
    vault_secret := vault.create_secret(in_secret, vault_name, normalized_provider);
    insert into public.provider_connections (
      org_id, provider, config, vault_secret_id, credential_last4, created_by, updated_by
    )
    values (
      in_org_id,
      normalized_provider,
      coalesce(in_config, '{}'::jsonb),
      vault_secret,
      right(in_secret, 4),
      actor,
      actor
    )
    returning provider_connections.id into existing_id;
  else
    perform vault.update_secret(existing_vault, in_secret, vault_name, normalized_provider);
    update public.provider_connections
    set
      config = coalesce(in_config, '{}'::jsonb),
      credential_last4 = right(in_secret, 4),
      updated_by = actor,
      updated_at = now()
    where provider_connections.id = existing_id;
  end if;

  -- Serving runtimes cache per endpoint revision; a key change (new, rotated)
  -- must reach live traffic now, not on the next unrelated endpoint edit.
  update public.endpoints
  set updated_at = now()
  where endpoints.org_id = in_org_id;

  return query
    select
      connections.id,
      connections.org_id,
      connections.provider,
      connections.config,
      connections.credential_last4
    from public.provider_connections connections
    where connections.id = existing_id;
end;
$$;

revoke all on function public.upsert_provider_connection(uuid, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_provider_connection(uuid, text, jsonb, text, text)
  to service_role;

-- Decrypt one org provider credential for a serving or optimization call.
create function public.release_provider_connection_credential(in_connection_id uuid)
returns table (credential text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_vault uuid;
  released text;
begin
  select connections.vault_secret_id
  into target_vault
  from public.provider_connections connections
  where connections.id = in_connection_id;

  if target_vault is null then
    raise exception 'provider connection not found: %', in_connection_id;
  end if;

  select decrypted_secret
  into released
  from vault.decrypted_secrets
  where vault.decrypted_secrets.id = target_vault;

  if released is null then
    raise exception 'provider connection credential is not decryptable: %', in_connection_id;
  end if;

  update public.provider_connections
  set last_used_at = now()
  where provider_connections.id = in_connection_id;

  return query select released;
end;
$$;

revoke all on function public.release_provider_connection_credential(uuid)
  from public, anon, authenticated;
grant execute on function public.release_provider_connection_credential(uuid)
  to service_role;

-- Disconnect: drop the row AND its Vault secret (mirrors delete_trace_connection).
create function public.delete_provider_connection(in_org_id uuid, in_provider text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_provider text := lower(nullif(btrim(in_provider), ''));
  target_id uuid;
  target_vault uuid;
begin
  select connections.id, connections.vault_secret_id
  into target_id, target_vault
  from public.provider_connections connections
  where connections.org_id = in_org_id
    and connections.provider = normalized_provider
  limit 1;

  if target_id is null then
    return false;
  end if;

  delete from public.provider_connections where provider_connections.id = target_id;
  delete from vault.secrets where vault.secrets.id = target_vault;
  -- Disconnect is a revocation: cached runtimes holding the released key must
  -- rebuild on the next request, not keep serving on it until a restart.
  update public.endpoints
  set updated_at = now()
  where endpoints.org_id = in_org_id;
  return true;
end;
$$;

revoke all on function public.delete_provider_connection(uuid, text)
  from public, anon, authenticated;
grant execute on function public.delete_provider_connection(uuid, text)
  to service_role;

-- Per-endpoint usage: token totals and the routed-model mix, for the model
-- page's Usage and Models tabs. Grouped by the routed model (null model =
-- rows captured before routing evidence landed; grouped as '' so the
-- percentages still sum). Priced spend and unpriced counts stay separate,
-- same honesty rule as serving_usage_rollup.
create function public.endpoint_usage_rollup(in_org uuid, in_endpoint uuid)
returns table (
  model text,
  request_count bigint,
  error_count bigint,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric,
  unpriced_count bigint
)
language sql
security definer
set search_path = ''
as $$
  select
    coalesce(requests.model, '') as model,
    count(*) filter (where requests.status = 'ok') as request_count,
    count(*) filter (where requests.status = 'error') as error_count,
    -- Tokens and cost sum over ALL rows: an errored request can still carry
    -- real billed usage (the capture layer keeps cost on errors and the spend
    -- trigger debits it), and a spend figure that dropped it would understate
    -- what the org was billed.
    coalesce(sum(requests.input_tokens), 0)::bigint as input_tokens,
    coalesce(sum(requests.output_tokens), 0)::bigint as output_tokens,
    coalesce(sum(requests.cost_usd), 0)::numeric as cost_usd,
    count(*) filter (where requests.status = 'ok' and requests.cost_usd is null)
      as unpriced_count
  from public.serving_requests requests
  where requests.org_id = in_org
    and requests.endpoint_id = in_endpoint
  group by coalesce(requests.model, '')
  order by request_count desc;
$$;

revoke all on function public.endpoint_usage_rollup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.endpoint_usage_rollup(uuid, uuid)
  to service_role;
