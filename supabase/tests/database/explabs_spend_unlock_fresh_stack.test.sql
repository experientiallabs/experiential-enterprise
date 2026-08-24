begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

-- 20260827120000 must keep the GoTrue-absent early return AFTER the
-- founder-preserving rewrite in 20260827000000. A later create or replace that
-- drops to_regclass('auth.users') breaks every fresh Docker migrate-and-seed.

select ok(
  pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.rotate_credentials_on_spend_unlock()'::pg_catalog.regprocedure
  )) like '%to_regclass%auth.users%',
  'spend-unlock rotation no-ops when auth.users is absent'
);

select ok(
  pg_catalog.lower(pg_catalog.pg_get_functiondef(
    'public.rotate_credentials_on_spend_unlock()'::pg_catalog.regprocedure
  )) like '%to_regclass%auth.sessions%',
  'spend-unlock rotation no-ops when auth.sessions is absent'
);

select * from finish();

rollback;
