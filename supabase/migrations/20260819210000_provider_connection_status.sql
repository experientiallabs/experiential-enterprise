-- Provider connection states: every BYOK credential carries an explicit,
-- provider-verified status. The status is written once by the hookup check
-- the moment a key is connected or rotated (the PUT handler probes the
-- provider inline) and afterwards only by real traffic failures — there is no
-- manual recheck surface by design.
--
-- Status is a KEY-level verdict. "Model not deployed" (the canonical Azure
-- case) is deliberately not a status: the key stays 'valid' and the
-- per-model fact lives under status_detail.models, computed by the model-page
-- deployment check and by traffic.
--
-- The connection provider set also widens with fireworks and modal: both ship
-- as full connection tiles. Modal's credential is the token_id+token_secret
-- pair stored as one JSON Vault secret; Fireworks carries account_id in the
-- non-secret config (needed for billing reads, not discoverable from the key).

-- 1. Admit fireworks and modal connections.
alter table public.provider_connections
  drop constraint provider_connections_provider_check;
alter table public.provider_connections
  add constraint provider_connections_provider_check check (
    provider in (
      'openai', 'anthropic', 'azure_openai', 'openrouter', 'gemini', 'bedrock',
      'fireworks', 'modal'
    )
  );

-- 2. The verified state and its verbose provider detail.
alter table public.provider_connections
  add column status text not null default 'unchecked'
    constraint provider_connections_status_check check (
      status in (
        'unchecked', 'valid', 'invalid', 'rate_limited', 'quota_exhausted', 'provider_error'
      )
    ),
  add column status_detail jsonb,
  add column status_checked_at timestamptz,
  add column status_source text
    constraint provider_connections_status_source_check check (
      status_source in ('hookup_check', 'traffic')
    );

comment on column public.provider_connections.status is
  'Provider-verified key state. unchecked = never probed; valid; invalid = provider rejected the credential; rate_limited; quota_exhausted; provider_error = the provider was unreachable or 5xx when we checked (our check failed, not their key).';
comment on column public.provider_connections.status_detail is
  'Verbose provider error capture: raw provider code and message, our remediation text, and per-model facts under a models key (e.g. Azure deployment missing while the key stays valid).';
comment on column public.provider_connections.status_checked_at is
  'When the status was last written, by the hookup check or by traffic.';
comment on column public.provider_connections.status_source is
  'Which path wrote the status: hookup_check (the probe run inside connect/rotate) or traffic (real serving failures/successes).';

-- 3. Rotation resets the verdict: a fresh key must never wear the previous
-- key's status while its own hookup check runs. Same signature, same return
-- shape; only the update branch changes.
create or replace function public.upsert_provider_connection(
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
      -- The rotated-in key has not been probed yet; the hookup check that
      -- runs inside the same PUT writes its real verdict moments later.
      status = 'unchecked',
      status_detail = null,
      status_checked_at = null,
      status_source = null,
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
