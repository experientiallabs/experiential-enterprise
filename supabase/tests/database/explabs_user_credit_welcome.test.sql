begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

-- Shape: one row per user marking the signup-credit welcome greeting as seen.
select has_table('public', 'user_credit_welcome', 'user_credit_welcome table exists');
select has_column(
  'public',
  'user_credit_welcome',
  'seen_at',
  'user_credit_welcome records when the greeting was first shown'
);

-- The web tier writes this table under the user's RLS session, so the
-- privileges are stated by migration rather than inherited from hosted default
-- privileges (stacks without them broke the sibling user_onboarding upsert).
select ok(
  has_table_privilege('authenticated', 'public.user_credit_welcome', 'select'),
  'authenticated can select its own seen row'
);
select ok(
  has_table_privilege('authenticated', 'public.user_credit_welcome', 'insert'),
  'authenticated can insert its own seen row'
);

-- Fixture: two users, one of whom has already seen the greeting. Signup
-- provisioning fires on these inserts; that is fine — this suite only reads
-- user_credit_welcome.
insert into auth.users (id, email)
values
  ('91000000-0000-0000-0000-000000000001', 'greeted@example.com'),
  ('91000000-0000-0000-0000-000000000002', 'fresh@example.com');

insert into public.user_credit_welcome (user_id)
values ('91000000-0000-0000-0000-000000000001');

-- A user reads only their own seen row.
select set_config('request.jwt.claim.sub', '91000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is(
  (select count(*)::int from public.user_credit_welcome),
  1,
  'a greeted user sees exactly their own row'
);

select lives_ok(
  $$
  insert into public.user_credit_welcome (user_id)
  values ('91000000-0000-0000-0000-000000000001')
  on conflict (user_id) do nothing
  $$,
  'claiming twice is a no-op, not an error'
);

select throws_ok(
  $$
  insert into public.user_credit_welcome (user_id)
  values ('91000000-0000-0000-0000-000000000002')
  $$,
  '42501',
  null,
  'a user cannot mark the greeting seen for someone else'
);

reset role;
select set_config('request.jwt.claim.sub', '91000000-0000-0000-0000-000000000002', true);
set local role authenticated;

select is(
  (select count(*)::int from public.user_credit_welcome),
  0,
  'a fresh user sees no seen row'
);

reset role;

-- Regression guard shared with user_onboarding: PostgREST publishes only the
-- PLURAL request.jwt.claims JSON, so the policies must resolve the user from
-- that form too (they go through authenticated_user_id(), which coalesces both
-- GUC shapes).
select set_config('request.jwt.claim.sub', '', true);
select set_config(
  'request.jwt.claims',
  '{"sub": "91000000-0000-0000-0000-000000000001", "role": "authenticated"}',
  true
);
set local role authenticated;

select is(
  (select count(*)::int from public.user_credit_welcome),
  1,
  'select-own resolves the user from plural request.jwt.claims'
);

reset role;

select * from finish();
rollback;
