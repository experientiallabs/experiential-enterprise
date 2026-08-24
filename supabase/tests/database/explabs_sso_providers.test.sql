begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- ---------------------------------------------------------------------------
-- E2 SSO substrate, sso_providers half: the Vault discipline (secret enters
-- through the upsert RPC, leaves only through the service-role release RPC),
-- one provider per org, the no-lockout invariants, and browser roles fully
-- denied. Ids prefixed '83...'.

insert into public.organizations (id, slug, name) values
  ('83000000-0000-0000-0000-000000000001', 'ssop-org-a', 'SSO Provider Org A');

-- ---------------------------------------------------------------------------
-- 1. No-lockout invariant: enabling requires a verified domain.

select throws_ok(
  $$select * from public.upsert_sso_provider(
      '83000000-0000-0000-0000-000000000001', 'saml',
      '{"metadata_url": "https://idp.example.com/metadata"}'::jsonb,
      'user', true)$$,
  'enabling SSO requires at least one verified domain',
  'an enabled provider cannot exist without a verified domain'
);

insert into public.org_domains (org_id, domain, verification_token, verified_at)
values ('83000000-0000-0000-0000-000000000001', 'ssop.example',
        'tok-83-aaaaaaaaaaaaaaaaaaaa', now());

-- ---------------------------------------------------------------------------
-- 2. Upsert: OIDC secret lands in Vault, never on the row's readable shape.

select results_eq(
  $$select provider_type, default_role, enabled, has_client_secret
      from public.upsert_sso_provider(
        '83000000-0000-0000-0000-000000000001', 'oidc',
        '{"issuer": "https://accounts.example.com", "client_id": "abc"}'::jsonb,
        'user', true, 'oidc-client-secret-83', 'user-83')$$,
  $$values ('oidc'::text, 'user'::text, true, true)$$,
  'the OIDC upsert stores the provider enabled with a Vault-held secret'
);

select is(
  (select count(*)::int from public.sso_providers
    where org_id = '83000000-0000-0000-0000-000000000001'),
  1,
  'one provider row per org'
);

select is(
  (select count(*)::int
     from vault.secrets secrets
     join public.sso_providers providers on providers.vault_secret_id = secrets.id
    where providers.org_id = '83000000-0000-0000-0000-000000000001'),
  1,
  'the client secret lives in Vault, referenced by vault_secret_id'
);

-- ---------------------------------------------------------------------------
-- 3. Release round-trips the secret; a second upsert rotates in place.

select results_eq(
  $$select credential from public.release_sso_provider_secret(
      '83000000-0000-0000-0000-000000000001')$$,
  $$values ('oidc-client-secret-83'::text)$$,
  'the release RPC decrypts the stored client secret'
);

select results_eq(
  $$select has_client_secret from public.upsert_sso_provider(
      '83000000-0000-0000-0000-000000000001', 'oidc',
      '{"issuer": "https://accounts.example.com", "client_id": "abc"}'::jsonb,
      'admin', true, 'oidc-client-secret-83-rotated')$$,
  $$values (true)$$,
  'a second upsert updates the single row (rotation, not duplication)'
);

select results_eq(
  $$select credential from public.release_sso_provider_secret(
      '83000000-0000-0000-0000-000000000001')$$,
  $$values ('oidc-client-secret-83-rotated'::text)$$,
  'rotation updates the Vault secret in place'
);

-- ---------------------------------------------------------------------------
-- 4. SAML carries no secret; switching to SAML retires the stored one.

select throws_ok(
  $$select * from public.upsert_sso_provider(
      '83000000-0000-0000-0000-000000000001', 'saml',
      '{"metadata_url": "https://idp.example.com/metadata"}'::jsonb,
      'user', true, 'not-a-saml-thing-123')$$,
  'a SAML provider carries no client secret',
  'a SAML upsert refuses a client secret'
);

select results_eq(
  $$select has_client_secret from public.upsert_sso_provider(
      '83000000-0000-0000-0000-000000000001', 'saml',
      '{"metadata_url": "https://idp.example.com/metadata"}'::jsonb,
      'user', true)$$,
  $$values (false)$$,
  'switching OIDC -> SAML drops the stored client secret'
);

select is(
  (select count(*)::int from vault.secrets
    where name like 'org:83000000-0000-0000-0000-000000000001:sso-provider:%'),
  0,
  'the retired client secret is gone from Vault'
);

-- ---------------------------------------------------------------------------
-- 5. No-lockout invariants against a domain that requires SSO.

update public.org_domains
   set sso_required = true
 where org_id = '83000000-0000-0000-0000-000000000001';

select throws_ok(
  $$select * from public.upsert_sso_provider(
      '83000000-0000-0000-0000-000000000001', 'saml',
      '{"metadata_url": "https://idp.example.com/metadata"}'::jsonb,
      'user', false)$$,
  'cannot disable the SSO provider while a domain requires SSO',
  'disabling is refused while a domain requires SSO'
);

select throws_ok(
  $$select public.delete_sso_provider('83000000-0000-0000-0000-000000000001')$$,
  'cannot delete the SSO provider while a domain requires SSO',
  'deletion is refused while a domain requires SSO'
);

update public.org_domains
   set sso_required = false
 where org_id = '83000000-0000-0000-0000-000000000001';

select is(
  public.delete_sso_provider('83000000-0000-0000-0000-000000000001'),
  true,
  'with the requirement lifted, deletion drops the provider row'
);

-- ---------------------------------------------------------------------------
-- 6. Browser roles: table unreadable, release path service-role-only.

set local role authenticated;

select throws_ok(
  $$select count(*) from public.sso_providers$$,
  '42501',
  null,
  'authenticated cannot read sso_providers'
);

select throws_ok(
  $$select * from public.release_sso_provider_secret(
      '83000000-0000-0000-0000-000000000001')$$,
  '42501',
  null,
  'authenticated cannot execute the release RPC (service-role only)'
);

select throws_ok(
  $$select * from public.upsert_sso_provider(
      '83000000-0000-0000-0000-000000000001', 'saml', '{}'::jsonb,
      'user', false)$$,
  '42501',
  null,
  'authenticated cannot execute the upsert RPC'
);

reset role;

select * from finish();

rollback;
