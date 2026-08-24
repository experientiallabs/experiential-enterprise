begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- ---------------------------------------------------------------------------
-- Storage: the pre-verify spend allowance is a nonnegative bigint on the
-- app_settings singleton, defaulting to $1 (1_000_000 micro-USD).

select is(
  (select pre_verify_allowance_micro_usd from public.app_settings),
  1000000::int8,
  'the singleton row defaults to $1 of pre-verify allowance (1_000_000 micro-USD)'
);

-- The consolidated credit-gate knobs default to the launch amounts.
select is(
  (select welcome_grant_micro_usd from public.app_settings),
  20000000::int8,
  'the welcome grant defaults to $20 (20_000_000 micro-USD)'
);

select is(
  (select yc_grant_micro_usd from public.app_settings),
  526000000::int8,
  'the YC grant defaults to $526 (526_000_000 micro-USD)'
);

select is(
  (select spend_unlock_requirement from public.app_settings),
  'email',
  'spend unlock defaults to inbox proof (email mode)'
);

select col_not_null(
  'public'::name, 'app_settings'::name, 'pre_verify_allowance_micro_usd'::name,
  'the allowance column is NOT NULL'
);

select col_type_is(
  'public'::name, 'app_settings'::name, 'pre_verify_allowance_micro_usd'::name, 'bigint',
  'the allowance is stored as a bigint (micro-USD)'
);

select throws_ok(
  $$update public.app_settings set pre_verify_allowance_micro_usd = -1$$,
  '23514',
  null,
  'a negative allowance is refused by the check constraint'
);

-- ---------------------------------------------------------------------------
-- Readability: the admin backend reads/writes as service_role, and the
-- gateway spend gate reads INSIDE gateway_start_attempt (SECURITY DEFINER),
-- which bypasses RLS. Prove both: service_role holds the table grant, and a
-- SECURITY DEFINER function reads the value even as a role (authenticated)
-- that has no direct privilege on the table at all.

select ok(
  has_table_privilege('service_role', 'public.app_settings', 'SELECT'),
  'service_role can read app_settings (the admin toggle read/write path)'
);

create function public._test_read_pre_verify()
returns pg_catalog.int8
language sql
security definer
set search_path = ''
as $$
  select pre_verify_allowance_micro_usd from public.app_settings limit 1;
$$;
grant execute on function public._test_read_pre_verify() to authenticated;

set local role authenticated;

-- authenticated has no direct grant on app_settings, so a bare read is denied;
-- the promo agent's gate must therefore read through the definer path.
select throws_ok(
  $$select pre_verify_allowance_micro_usd from public.app_settings$$,
  '42501',
  null,
  'authenticated cannot read app_settings directly (no grant)'
);

select is(
  public._test_read_pre_verify(),
  1000000::int8,
  'a SECURITY DEFINER function reads the allowance even as authenticated — the gateway_start_attempt read path'
);

reset role;

select * from finish();

rollback;
