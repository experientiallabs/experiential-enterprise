begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

select isnt_empty(
  $$
  select 1
  from auth.users
  where id = '00000000-0000-0000-0000-000000000099'
    and email = 'admin@xplabs.ai'
    and encrypted_password is not null
    and email_confirmed_at is not null
  $$,
  'seed creates confirmed admin auth user'
);

select isnt_empty(
  $$
  select 1
  from auth.identities
  where user_id = '00000000-0000-0000-0000-000000000099'
    and provider = 'email'
  $$,
  'seed creates admin email identity'
);

select isnt_empty(
  $$
  select 1
  from public.organization_members
  where org_id = '00000000-0000-0000-0000-000000000001'
    and user_id = '00000000-0000-0000-0000-000000000099'
    and role = 'admin'
  $$,
  'seed grants admin access to Experiential Labs org'
);

select isnt_empty(
  $$
  select 1
  from public.account_workspaces
  where user_id = '00000000-0000-0000-0000-000000000099'
    and org_id = '00000000-0000-0000-0000-000000000001'
  $$,
  'seed marks the admin workspace for starter-world-model bootstrap'
);

select * from finish();

rollback;
