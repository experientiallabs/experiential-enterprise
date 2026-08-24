-- Per-org IdP registration (E2 SSO substrate, /ee): one SAML or OIDC
-- provider per organization to start (org_id is unique). The row carries
-- ONLY non-secret configuration — issuer / metadata URL / attribute mapping
-- in metadata jsonb. An OIDC client secret follows the provider_connections
-- Vault discipline exactly: it enters through the upsert RPC, lives only in
-- Vault (vault_secret_id on the row), and leaves only through the
-- service-role release RPC.
--
-- Privilege posture: newest era — RLS on, zero policies, revoke-all;
-- service_role reads the table, and every WRITE goes through the definer
-- RPCs below (the Vault handling forces a single write path anyway). The
-- RPCs also carry the two lockout invariants so no writer can strand a
-- tenant: enabling requires a verified domain, and the provider cannot be
-- disabled or deleted while any domain still has sso_required set.
--
-- GoTrue IdP registration (the admin SSO API call that makes sign-in work)
-- deliberately does NOT land here; see explabs/api/routes/sso.py
-- _sync_provider_to_gotrue for the marked seam.

create table public.sso_providers (
  id               pg_catalog.uuid primary key default pg_catalog.gen_random_uuid(),
  org_id           pg_catalog.uuid not null unique
    references public.organizations(id) on delete cascade,
  provider_type    pg_catalog.text not null
    check (provider_type in ('saml', 'oidc')),
  -- Non-secret IdP config: issuer / metadata_url / client_id / attribute
  -- mapping. NEVER credentials; the OIDC client secret lives in Vault only.
  metadata         pg_catalog.jsonb not null default '{}'::pg_catalog.jsonb,
  vault_secret_id  pg_catalog.uuid,
  -- Role granted to identities the IdP maps into the org.
  default_role     pg_catalog.text not null default 'user'
    check (default_role in ('admin', 'user')),
  enabled          pg_catalog.bool not null default false,
  created_by       pg_catalog.text,
  updated_by       pg_catalog.text,
  created_at       pg_catalog.timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at       pg_catalog.timestamptz not null default pg_catalog.clock_timestamp()
);

comment on table public.sso_providers is
  'Per-org IdP registration (E2 SSO substrate): one SAML/OIDC provider per org. Non-secret config only; the OIDC client secret lives in Vault (vault_secret_id) via upsert_sso_provider and is released only by the service-role release RPC. Writes go through the definer RPCs, which enforce the no-lockout invariants.';

alter table public.sso_providers enable row level security;

revoke all on table public.sso_providers
  from public, anon, authenticated, service_role;

grant select on table public.sso_providers to service_role;

-- ---------------------------------------------------------------------------
-- Create or update one org's provider (same pattern as
-- upsert_provider_connection; rotation updates the Vault secret in place).

create function public.upsert_sso_provider(
  in_org_id pg_catalog.uuid,
  in_provider_type pg_catalog.text,
  in_metadata pg_catalog.jsonb,
  in_default_role pg_catalog.text,
  in_enabled pg_catalog.bool,
  in_secret pg_catalog.text default null,
  in_actor pg_catalog.text default null
)
returns table (
  id pg_catalog.uuid,
  org_id pg_catalog.uuid,
  provider_type pg_catalog.text,
  metadata pg_catalog.jsonb,
  default_role pg_catalog.text,
  enabled pg_catalog.bool,
  has_client_secret pg_catalog.bool
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_type text := lower(nullif(btrim(in_provider_type), ''));
  actor text := nullif(btrim(in_actor), '');
  existing_id uuid;
  existing_vault uuid;
  vault_secret uuid;
  vault_name text;
begin
  if normalized_type is null or normalized_type not in ('saml', 'oidc') then
    raise exception 'provider_type must be saml or oidc';
  end if;
  if in_default_role is null or in_default_role not in ('admin', 'user') then
    raise exception 'default_role must be admin or user';
  end if;
  if normalized_type = 'saml' and in_secret is not null then
    raise exception 'a SAML provider carries no client secret';
  end if;
  if in_secret is not null and length(in_secret) < 12 then
    raise exception 'the OIDC client secret is too short to be a real credential';
  end if;
  if not exists (select 1 from public.organizations where organizations.id = in_org_id) then
    raise exception 'organization not found: %', in_org_id;
  end if;
  -- No-lockout invariant #1: an enabled provider must have somewhere to
  -- apply — at least one verified domain.
  if in_enabled and not exists (
    select 1 from public.org_domains domains
     where domains.org_id = in_org_id and domains.verified_at is not null
  ) then
    raise exception 'enabling SSO requires at least one verified domain';
  end if;
  -- No-lockout invariant #2: while any domain requires SSO, the provider
  -- must stay enabled — disabling it would strand every member at step-up
  -- with no IdP to step up through.
  if not in_enabled and exists (
    select 1 from public.org_domains domains
     where domains.org_id = in_org_id
       and domains.sso_required
       and domains.verified_at is not null
  ) then
    raise exception 'cannot disable the SSO provider while a domain requires SSO';
  end if;

  select providers.id, providers.vault_secret_id
    into existing_id, existing_vault
    from public.sso_providers providers
   where providers.org_id = in_org_id
   limit 1;

  vault_name := format(
    'org:%s:sso-provider:%s', in_org_id::text, gen_random_uuid()::text
  );

  if existing_id is null then
    if in_secret is not null then
      vault_secret := vault.create_secret(in_secret, vault_name, normalized_type);
    end if;
    insert into public.sso_providers (
      org_id, provider_type, metadata, vault_secret_id, default_role,
      enabled, created_by, updated_by
    )
    values (
      in_org_id,
      normalized_type,
      coalesce(in_metadata, '{}'::jsonb),
      vault_secret,
      in_default_role,
      in_enabled,
      actor,
      actor
    )
    returning sso_providers.id into existing_id;
  else
    if in_secret is not null then
      if existing_vault is null then
        vault_secret := vault.create_secret(in_secret, vault_name, normalized_type);
      else
        perform vault.update_secret(existing_vault, in_secret, vault_name, normalized_type);
        vault_secret := existing_vault;
      end if;
    elsif normalized_type = 'saml' and existing_vault is not null then
      -- Switching OIDC -> SAML retires the now-meaningless client secret.
      delete from vault.secrets where vault.secrets.id = existing_vault;
      vault_secret := null;
    else
      -- OIDC update without a new secret keeps the stored one.
      vault_secret := existing_vault;
    end if;
    update public.sso_providers
       set provider_type = normalized_type,
           metadata = coalesce(in_metadata, '{}'::jsonb),
           vault_secret_id = vault_secret,
           default_role = in_default_role,
           enabled = in_enabled,
           updated_by = actor,
           updated_at = now()
     where sso_providers.id = existing_id;
  end if;

  return query
    select
      providers.id,
      providers.org_id,
      providers.provider_type,
      providers.metadata,
      providers.default_role,
      providers.enabled,
      providers.vault_secret_id is not null
      from public.sso_providers providers
     where providers.id = existing_id;
end;
$$;

revoke all on function public.upsert_sso_provider(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.upsert_sso_provider(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text, pg_catalog.text
) to service_role;

-- ---------------------------------------------------------------------------
-- Decrypt one org's OIDC client secret (for the GoTrue registration call
-- when that seam lands). Service-role only, like every credential release.

create function public.release_sso_provider_secret(in_org_id pg_catalog.uuid)
returns table (credential pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_vault uuid;
  released text;
begin
  select providers.vault_secret_id
    into target_vault
    from public.sso_providers providers
   where providers.org_id = in_org_id;

  if target_vault is null then
    raise exception 'sso provider has no stored client secret: %', in_org_id;
  end if;

  select decrypted_secret
    into released
    from vault.decrypted_secrets
   where vault.decrypted_secrets.id = target_vault;

  if released is null then
    raise exception 'sso provider client secret is not decryptable: %', in_org_id;
  end if;

  return query select released;
end;
$$;

revoke all on function public.release_sso_provider_secret(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.release_sso_provider_secret(pg_catalog.uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Delete one org's provider: drop the row AND its Vault secret (mirrors
-- delete_provider_connection), refusing while any domain requires SSO.

create function public.delete_sso_provider(in_org_id pg_catalog.uuid)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_id uuid;
  target_vault uuid;
begin
  if exists (
    select 1 from public.org_domains domains
     where domains.org_id = in_org_id
       and domains.sso_required
       and domains.verified_at is not null
  ) then
    raise exception 'cannot delete the SSO provider while a domain requires SSO';
  end if;

  select providers.id, providers.vault_secret_id
    into target_id, target_vault
    from public.sso_providers providers
   where providers.org_id = in_org_id
   limit 1;

  if target_id is null then
    return false;
  end if;

  delete from public.sso_providers where sso_providers.id = target_id;
  if target_vault is not null then
    delete from vault.secrets where vault.secrets.id = target_vault;
  end if;
  return true;
end;
$$;

revoke all on function public.delete_sso_provider(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.delete_sso_provider(pg_catalog.uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- The step-up sign-in descriptor: given an org slug (carried by the
-- /signin?sso_required=<slug> redirect), the provider type and one verified
-- domain to start the GoTrue SSO flow with — only when a provider exists AND
-- is enabled. Authenticated-only: step-up sessions are signed in (step-up
-- means "signed in with the wrong method"), and signed-out visitors get the
-- neutral copy without the button. Metadata returned is the minimum the
-- sign-in button needs; never attribute mappings or issuer internals.

create function public.org_sso_signin_provider(in_slug pg_catalog.text)
returns table (provider_type pg_catalog.text, domain pg_catalog.text)
language sql
stable
security definer
set search_path = ''
as $$
  select providers.provider_type, domains.domain
    from public.sso_providers providers
    join public.organizations orgs on orgs.id = providers.org_id
    join public.org_domains domains
      on domains.org_id = providers.org_id
     and domains.verified_at is not null
   where orgs.slug = in_slug
     and providers.enabled
   order by domains.sso_required desc, domains.domain
   limit 1;
$$;

revoke all on function public.org_sso_signin_provider(pg_catalog.text)
  from public, anon;
grant execute on function public.org_sso_signin_provider(pg_catalog.text)
  to authenticated, service_role;
