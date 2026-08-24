begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

-- Provisioning is irrelevant here; keep the trigger from creating orgs for
-- the fixture users so the file leaves no tenancy behind.
update public.app_settings set signups_enabled = false;

-- Password account: one 'email' identity.
insert into auth.users (id, email)
values ('41000000-0000-0000-0000-000000000001', 'Password.User@example.com');
insert into auth.identities (user_id, provider, provider_id, identity_data)
values (
  '41000000-0000-0000-0000-000000000001',
  'email',
  '41000000-0000-0000-0000-000000000001',
  '{"sub": "41000000-0000-0000-0000-000000000001"}'::jsonb
);

-- OAuth-only account: google + github, no password identity.
insert into auth.users (id, email)
values ('41000000-0000-0000-0000-000000000002', 'oauth.user@example.com');
insert into auth.identities (user_id, provider, provider_id, identity_data)
values
  (
    '41000000-0000-0000-0000-000000000002',
    'google',
    'google-oauth-user',
    '{"sub": "google-oauth-user"}'::jsonb
  ),
  (
    '41000000-0000-0000-0000-000000000002',
    'github',
    'github-oauth-user',
    '{"sub": "github-oauth-user"}'::jsonb
  );

-- Mixed account: password plus a linked OAuth identity (the web layer
-- branches on 'email' being among the methods).
insert into auth.users (id, email)
values ('41000000-0000-0000-0000-000000000003', 'mixed.user@example.com');
insert into auth.identities (user_id, provider, provider_id, identity_data)
values
  (
    '41000000-0000-0000-0000-000000000003',
    'email',
    '41000000-0000-0000-0000-000000000003',
    '{"sub": "41000000-0000-0000-0000-000000000003"}'::jsonb
  ),
  (
    '41000000-0000-0000-0000-000000000003',
    'google',
    'google-mixed-user',
    '{"sub": "google-mixed-user"}'::jsonb
  );

-- Soft-deleted account: must report no methods, like no account at all.
insert into auth.users (id, email, deleted_at)
values ('41000000-0000-0000-0000-000000000004', 'deleted.user@example.com', now());
insert into auth.identities (user_id, provider, provider_id, identity_data)
values (
  '41000000-0000-0000-0000-000000000004',
  'email',
  '41000000-0000-0000-0000-000000000004',
  '{"sub": "41000000-0000-0000-0000-000000000004"}'::jsonb
);

select is(
  public.signin_methods_for_email('password.user@example.com'),
  array['email'],
  'password account reports its email identity, case-insensitively'
);

select is(
  public.signin_methods_for_email('  Password.User@example.com  '),
  array['email'],
  'surrounding whitespace is trimmed before matching'
);

select is(
  public.signin_methods_for_email('oauth.user@example.com'),
  array['github', 'google'],
  'OAuth-only account reports every provider identity, sorted'
);

select is(
  public.signin_methods_for_email('mixed.user@example.com'),
  array['email', 'google'],
  'password-plus-OAuth account reports both methods'
);

select is(
  public.signin_methods_for_email('nobody@example.com'),
  '{}'::text[],
  'unknown address reports no methods'
);

select is(
  public.signin_methods_for_email('deleted.user@example.com'),
  '{}'::text[],
  'soft-deleted account reports no methods'
);

-- The oracle is service-role only: anon and authenticated must not be able
-- to probe account existence, while the service role (the web layer's
-- admin client) must keep its execute grant.
select ok(
  not has_function_privilege('anon', 'public.signin_methods_for_email(text)', 'execute'),
  'anon cannot execute the lookup'
);
select ok(
  not has_function_privilege('authenticated', 'public.signin_methods_for_email(text)', 'execute'),
  'authenticated cannot execute the lookup'
);
select function_privs_are(
  'public',
  'signin_methods_for_email',
  array['text'],
  'service_role',
  array['EXECUTE'],
  'service_role can execute the lookup'
);

select * from finish();

rollback;
