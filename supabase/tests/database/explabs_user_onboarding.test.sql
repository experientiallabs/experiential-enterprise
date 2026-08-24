begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- Shape: one row per user marking first-run onboarding as finished/skipped.
select has_table('public', 'user_onboarding', 'user_onboarding table exists');
select has_column(
  'public',
  'user_onboarding',
  'completed_at',
  'user_onboarding records when the flow finished'
);

-- The web tier writes this table under the user's RLS session, so the
-- privileges must be stated by migration rather than inherited from hosted
-- default privileges (stacks without them broke the completion upsert).
select ok(
  has_table_privilege('authenticated', 'public.user_onboarding', 'select'),
  'authenticated can select its completion row'
);
select ok(
  has_table_privilege('authenticated', 'public.user_onboarding', 'insert'),
  'authenticated can insert its completion row'
);

-- Fixture: two users, one of whom has completed onboarding. Signup
-- provisioning fires on these inserts; that is fine — this suite only reads
-- user_onboarding.
insert into auth.users (id, email)
values
  ('90000000-0000-0000-0000-000000000001', 'onboarded@example.com'),
  ('90000000-0000-0000-0000-000000000002', 'fresh@example.com');

insert into public.user_onboarding (user_id)
values ('90000000-0000-0000-0000-000000000001');

-- A user reads only their own completion row.
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is(
  (select count(*)::int from public.user_onboarding),
  1,
  'a completed user sees exactly their own row'
);

select lives_ok(
  $$
  insert into public.user_onboarding (user_id)
  values ('90000000-0000-0000-0000-000000000001')
  on conflict (user_id) do nothing
  $$,
  'completing twice is a no-op, not an error'
);

select throws_ok(
  $$
  insert into public.user_onboarding (user_id)
  values ('90000000-0000-0000-0000-000000000002')
  $$,
  '42501',
  null,
  'a user cannot mark onboarding complete for someone else'
);

reset role;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
set local role authenticated;

select is(
  (select count(*)::int from public.user_onboarding),
  0,
  'a fresh user sees no completion row'
);

reset role;

-- Regression: PostgREST publishes only the PLURAL request.jwt.claims JSON;
-- the deployed stack never sets the singular claim the assertions above use.
-- The policies must resolve the user from the plural form too (they now go
-- through authenticated_user_id(), which coalesces both GUC shapes).
select set_config('request.jwt.claim.sub', '', true);
select set_config(
  'request.jwt.claims',
  '{"sub": "90000000-0000-0000-0000-000000000001", "role": "authenticated"}',
  true
);
set local role authenticated;

select is(
  (select count(*)::int from public.user_onboarding),
  1,
  'select-own resolves the user from plural request.jwt.claims'
);

select lives_ok(
  $$
  insert into public.user_onboarding (user_id)
  values ('90000000-0000-0000-0000-000000000001')
  on conflict (user_id) do nothing
  $$,
  'insert-own resolves the user from plural request.jwt.claims'
);

reset role;

select * from finish();
rollback;
