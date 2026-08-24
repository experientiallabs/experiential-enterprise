-- SCIM provisioning + persisted identity ownership (design E3).
--
-- Two tables and one trigger repair:
--
-- 1. `account_provenance` — WHO created this account. A row exists ONLY when
--    an org-controlled provisioning path created the `auth.users` row itself
--    (that org's SCIM create, or IdP-initiated JIT signup where no account
--    previously existed). An existing account that later signs in through an
--    org's IdP is being *linked*, not provisioned, and never gains an owner
--    retroactively — which is why service_role holds no UPDATE privilege on
--    this table: ownership is written once at creation or never.
--
-- 2. `org_scim_tokens` — the per-org SCIM bearer. Hash-only storage, exactly
--    the `api_keys` discipline: the IdP presents this bearer on every SCIM
--    request, so authentication must be a pure SHA-256 lookup with no Vault
--    round-trip, and operator re-display is deliberately unsupported (the
--    token is shown once at mint, like an `xpl_` key). Vault storage was
--    considered and dropped: it would add a second secret store whose only
--    consumer would be a re-display surface the product refuses to ship.
--
-- 3. `provision_signup_org()` gains a managed-provisioning guard: an
--    org-controlled path (SCIM today, SSO JIT next) creates the GoTrue user
--    with `explabs_provisioned_via` in its metadata, and the self-serve
--    signup trigger must NOT also provision a personal org (welcome credit,
--    starter examples) for an account an enterprise IdP just created — the
--    provisioning path inserts the intended org membership itself, and a
--    stray personal membership would permanently exempt the account from the
--    zero-remaining-memberships deprovisioning cleanup.

-- ---------------------------------------------------------------------------
-- Persisted identity ownership.

create table public.account_provenance (
  -- No FK: GoTrue owns auth.users (same convention as organization_members).
  user_id uuid primary key,
  provisioned_by_org_id uuid not null,
  provisioned_via text not null check (provisioned_via in ('scim', 'sso_jit')),
  created_at timestamptz not null default now()
);

comment on table public.account_provenance is
  'Persisted identity ownership: a row exists only when an org-controlled provisioning path (SCIM create, SSO JIT signup) created the auth.users row itself. Never written retroactively for linked accounts; no UPDATE path exists by design.';

-- Ownership drives the org-scoped deprovisioning sweep's global-cleanup
-- decision, so the FK to organizations is deliberate: an owner org that no
-- longer exists must read as "ownerless", and the cascade encodes that.
alter table public.account_provenance
  add constraint account_provenance_org_fk
  foreign key (provisioned_by_org_id) references public.organizations(id)
  on delete cascade;

-- RLS on with zero policies: service-role only, like the gateway-era tables.
alter table public.account_provenance enable row level security;

revoke all on table public.account_provenance
  from public, anon, authenticated, service_role;

-- select: the sweep's ownership check; insert: the provisioning paths;
-- delete: account-deletion cleanup. NO update — ownership is immutable.
grant select, insert, delete on table public.account_provenance to service_role;

-- ---------------------------------------------------------------------------
-- Per-org SCIM bearer tokens.

create table public.org_scim_tokens (
  -- One SCIM credential per org: minting again replaces the row.
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- SHA-256 hex digest of the full plaintext bearer; unique doubles as the
  -- per-request lookup index (mirrors api_keys.key_hash).
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Last characters of the plaintext, display only.
  token_last4 text not null,
  -- The org's standing policy for what the deprovisioning sweep does with
  -- org-scoped api_keys the departing user created ('revoke' or 'keep').
  deprovision_key_policy text not null default 'revoke'
    check (deprovision_key_policy in ('revoke', 'keep')),
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid
);

comment on table public.org_scim_tokens is
  'Per-org SCIM 2.0 bearer credential, hash-only like api_keys (shown once at mint, never re-displayed). deprovision_key_policy is the org''s standing choice for user-created key revocation during the deprovisioning sweep.';

alter table public.org_scim_tokens enable row level security;

revoke all on table public.org_scim_tokens
  from public, anon, authenticated, service_role;

-- update carries the revocation stamp; delete lets a re-mint replace the row.
grant select, insert, update, delete on table public.org_scim_tokens to service_role;

-- ---------------------------------------------------------------------------
-- Managed-provisioning guard on the self-serve signup trigger. Reapplies the
-- 20260713200000 body verbatim plus the early return marked GUARD below.

create or replace function public.provision_signup_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite record;
  invites_applied boolean := false;
  open_signups boolean;
  new_org_id uuid;
  email_local text;
  org_label text;
  org_slug text;
  invite_token text;
begin
  -- Seeded users receive their membership and account-workspace marker from
  -- seed.sql, so normal signup provisioning must leave them unchanged.
  if nullif(current_setting('explabs.seed_admin_email', true), '') = new.email then
    return new;
  end if;

  -- GUARD: an org-controlled provisioning path (SCIM, SSO JIT) created this
  -- account and inserts the intended org membership itself; self-serve
  -- provisioning (invites, personal org, starter examples) must not run.
  if coalesce(new.raw_user_meta_data ->> 'explabs_provisioned_via', '') <> '' then
    return new;
  end if;

  invite_token := nullif(new.raw_user_meta_data ->> 'invite_token', '');
  if invite_token is not null then
    for invite in
      select invitations.id, invitations.org_id, invitations.role, invitations.org_name
      from public.org_invitations invitations
      where invitations.accepted_at is null
        and invitations.revoked_at is null
        and invitations.expires_at > now()
        and invitations.token = invite_token
      for update
    loop
      if invite.org_id is not null then
        insert into public.organization_members (org_id, user_id, role)
        values (invite.org_id, new.id, invite.role)
        on conflict (org_id, user_id) do nothing;
      else
        org_label := invite.org_name;
        org_slug := trim(both '-' from regexp_replace(lower(org_label), '[^a-z0-9]+', '-', 'g'));
        if org_slug = '' then
          org_slug := 'org';
        end if;
        org_slug := org_slug || '-' || left(new.id::text, 8);

        insert into public.organizations (slug, name)
        values (org_slug, org_label)
        returning id into new_org_id;

        insert into public.organization_members (org_id, user_id, role)
        values (new_org_id, new.id, 'admin');
      end if;

      update public.org_invitations
      set accepted_at = now(), accepted_by = new.id
      where id = invite.id;

      invites_applied := true;
    end loop;
  end if;

  if invites_applied then
    return new;
  end if;

  -- Verified-domain joins (org_domains) slot in here once that table exists.

  select settings.signups_enabled into open_signups
  from public.app_settings settings;
  if not coalesce(open_signups, false) then
    return new;
  end if;

  email_local := lower(
    coalesce(nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'user')
  );
  org_slug := regexp_replace(email_local, '[^a-z0-9]+', '-', 'g')
    || '-' || left(new.id::text, 8);

  insert into public.organizations (slug, name)
  values (org_slug, email_local)
  returning id into new_org_id;

  insert into public.organization_members (org_id, user_id, role)
  values (new_org_id, new.id, 'admin');

  insert into public.account_workspaces (user_id, org_id)
  values (new.id, new_org_id);

  return new;
end;
$$;
