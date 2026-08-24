-- Anchor the plus-alias branch of is_synthetic_email to the synthetic-account
-- convention.
--
-- 20260826130000 classified ANY plus-addressed email as synthetic
-- (in_email ~ '\+[^@]*@'). Plus-addressing is common at signup, so a real
-- customer signing up as jane+explabs@gmail.com was classified synthetic:
-- their signup went unannounced and, worse, expire_synthetic_accounts revoked
-- their org's live api keys and deleted their auth.users row on the next
-- hourly run past 24h. The convention that tests/synthetic-email.ts actually
-- mints is a plus-alias of the monitored operations mailbox, so
-- match exactly that; the two pre-convention shapes stay as they were, both
-- already confined to domains we own.

create or replace function public.is_synthetic_email(in_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select in_email is not null
     and (in_email ~* '^silen\+[^@]*@experientiallabs\.ai$'
          or in_email ~* '@example\.(com|org|net)$'
          or in_email ~* '[0-9]{10,}@experientiallabs\.ai$');
$$;
