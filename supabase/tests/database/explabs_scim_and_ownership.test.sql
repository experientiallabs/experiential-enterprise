begin;

create extension if not exists pgtap with schema extensions;

select plan(23);

-- ---------------------------------------------------------------------------
-- E3 SCIM schema: account_provenance is service-role-only immutable identity
-- ownership, org_scim_tokens is the hash-only per-org SCIM bearer, and the
-- signup trigger skips accounts an org-controlled path provisioned. All ids
-- are prefixed '76...' so ambient seed data cannot perturb the assertions.

insert into public.organizations (id, slug, name) values
  ('76000000-0000-0000-0000-000000000001', 'scim-org-a', 'SCIM Org A'),
  ('76000000-0000-0000-0000-000000000002', 'scim-org-b', 'SCIM Org B');

-- ---------------------------------------------------------------------------
-- 1. account_provenance posture: RLS on, zero policies, service-role only,
--    and no UPDATE privilege even for service_role (ownership is immutable).

select is(
  (select relrowsecurity from pg_class
   where oid = 'public.account_provenance'::regclass),
  true,
  'account_provenance has row level security enabled'
);

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'account_provenance'),
  0,
  'account_provenance carries zero RLS policies (definer/service paths only)'
);

select ok(
  not has_table_privilege('authenticated', 'public.account_provenance', 'select'),
  'authenticated cannot read account_provenance'
);

select ok(
  has_table_privilege('service_role', 'public.account_provenance', 'select')
    and has_table_privilege('service_role', 'public.account_provenance', 'insert')
    and has_table_privilege('service_role', 'public.account_provenance', 'delete'),
  'service_role can select, insert, and delete provenance rows'
);

select ok(
  not has_table_privilege('service_role', 'public.account_provenance', 'update'),
  'service_role cannot UPDATE provenance: ownership is never rewritten'
);

-- ---------------------------------------------------------------------------
-- 2. Provenance content rules: one row per user, valid via values only, and
--    the owner-org FK cascades so a deleted org reads as "ownerless".

insert into public.account_provenance (user_id, provisioned_by_org_id, provisioned_via)
values ('76000000-0000-0000-0000-0000000000aa',
        '76000000-0000-0000-0000-000000000001', 'scim');

select throws_ok(
  $$insert into public.account_provenance (user_id, provisioned_by_org_id, provisioned_via)
    values ('76000000-0000-0000-0000-0000000000aa',
            '76000000-0000-0000-0000-000000000002', 'sso_jit')$$,
  '23505',
  null,
  'a user carries at most one provenance row (ownership cannot be re-claimed)'
);

select throws_ok(
  $$insert into public.account_provenance (user_id, provisioned_by_org_id, provisioned_via)
    values ('76000000-0000-0000-0000-0000000000ab',
            '76000000-0000-0000-0000-000000000001', 'invited')$$,
  '23514',
  null,
  'provisioned_via admits only the org-controlled creation paths'
);

insert into public.account_provenance (user_id, provisioned_by_org_id, provisioned_via)
values ('76000000-0000-0000-0000-0000000000ac',
        '76000000-0000-0000-0000-000000000002', 'sso_jit');

delete from public.organizations where id = '76000000-0000-0000-0000-000000000002';

select is_empty(
  $$select 1 from public.account_provenance
    where user_id = '76000000-0000-0000-0000-0000000000ac'$$,
  'deleting the owner org cascades: the account reads as ownerless'
);

-- ---------------------------------------------------------------------------
-- 3. org_scim_tokens posture.

select is(
  (select relrowsecurity from pg_class
   where oid = 'public.org_scim_tokens'::regclass),
  true,
  'org_scim_tokens has row level security enabled'
);

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'org_scim_tokens'),
  0,
  'org_scim_tokens carries zero RLS policies'
);

select ok(
  not has_table_privilege('authenticated', 'public.org_scim_tokens', 'select'),
  'authenticated cannot read org_scim_tokens'
);

select ok(
  has_table_privilege('service_role', 'public.org_scim_tokens', 'select')
    and has_table_privilege('service_role', 'public.org_scim_tokens', 'insert')
    and has_table_privilege('service_role', 'public.org_scim_tokens', 'update')
    and has_table_privilege('service_role', 'public.org_scim_tokens', 'delete'),
  'service_role holds the full token lifecycle (mint, revoke, replace)'
);

-- ---------------------------------------------------------------------------
-- 4. Token content rules: hash shape, hash uniqueness, one row per org, and
--    the key-policy vocabulary.

insert into public.org_scim_tokens (org_id, token_hash, token_last4, created_by)
values ('76000000-0000-0000-0000-000000000001', repeat('ab', 32), 'ab12',
        '76000000-0000-0000-0000-0000000000aa');

select throws_ok(
  $$insert into public.org_scim_tokens (org_id, token_hash, token_last4)
    values ('76000000-0000-0000-0000-000000000001', repeat('cd', 32), 'cd34')$$,
  '23505',
  null,
  'one SCIM token row per org (re-mint replaces, never accumulates)'
);

select throws_ok(
  $$insert into public.org_scim_tokens (org_id, token_hash, token_last4)
    values ('76000000-0000-0000-0000-000000000003', 'not-a-hash', 'xxxx')$$,
  '23514',
  null,
  'token_hash must be a 64-char lowercase hex SHA-256 digest'
);

insert into public.organizations (id, slug, name) values
  ('76000000-0000-0000-0000-000000000003', 'scim-org-c', 'SCIM Org C');

select throws_ok(
  $$insert into public.org_scim_tokens (org_id, token_hash, token_last4)
    values ('76000000-0000-0000-0000-000000000003', repeat('ab', 32), 'ab12')$$,
  '23505',
  null,
  'a token hash resolves to exactly one org'
);

select throws_ok(
  $$insert into public.org_scim_tokens (org_id, token_hash, token_last4, deprovision_key_policy)
    values ('76000000-0000-0000-0000-000000000003', repeat('ef', 32), 'ef56', 'transfer')$$,
  '23514',
  null,
  'deprovision_key_policy admits only revoke and keep'
);

select is(
  (select deprovision_key_policy from public.org_scim_tokens
   where org_id = '76000000-0000-0000-0000-000000000001'),
  'revoke',
  'the key policy defaults to revoke (the safe offboarding default)'
);

delete from public.organizations where id = '76000000-0000-0000-0000-000000000001';

select is_empty(
  $$select 1 from public.org_scim_tokens
    where org_id = '76000000-0000-0000-0000-000000000001'$$,
  'deleting an org cascades its SCIM token away'
);

-- ---------------------------------------------------------------------------
-- 5. Signup-trigger guard: a managed-provisioning marker suppresses the
--    self-serve personal org; an unmarked signup still provisions one.

update public.app_settings set signups_enabled = true;

insert into auth.users (id, email, raw_user_meta_data)
values ('76000000-0000-0000-0000-0000000000ba', 'scim-provisioned@example.com',
        '{"explabs_provisioned_via": "scim"}'::jsonb);

select is_empty(
  $$select 1 from public.organization_members
    where user_id = '76000000-0000-0000-0000-0000000000ba'$$,
  'a SCIM-provisioned account gets no self-serve membership from the trigger'
);

select is_empty(
  $$select 1 from public.account_workspaces
    where user_id = '76000000-0000-0000-0000-0000000000ba'$$,
  'a SCIM-provisioned account gets no personal workspace'
);

insert into auth.users (id, email)
values ('76000000-0000-0000-0000-0000000000bb', 'self-serve-control@example.com');

select isnt_empty(
  $$select 1
    from public.organizations orgs
    join public.organization_members members on members.org_id = orgs.id
    where members.user_id = '76000000-0000-0000-0000-0000000000bb'$$,
  'an unmarked signup still provisions its personal org (guard is surgical)'
);

-- The SSO JIT path reuses the same marker vocabulary.
insert into auth.users (id, email, raw_user_meta_data)
values ('76000000-0000-0000-0000-0000000000bc', 'jit-provisioned@example.com',
        '{"explabs_provisioned_via": "sso_jit"}'::jsonb);

select is_empty(
  $$select 1 from public.organization_members
    where user_id = '76000000-0000-0000-0000-0000000000bc'$$,
  'an SSO-JIT-provisioned account is equally exempt from self-serve provisioning'
);

select is(
  (select count(*)::int from public.account_provenance
   where user_id in ('76000000-0000-0000-0000-0000000000ba',
                     '76000000-0000-0000-0000-0000000000bc')),
  0,
  'the trigger itself never writes provenance: only the provisioning path does'
);

select * from finish();

rollback;
