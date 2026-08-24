-- Grant the table privilege the user_onboarding RLS policies assume.
--
-- 20260710010000_user_onboarding created insert-own/select-own policies for
-- `authenticated` but never granted table-level INSERT, and Postgres checks
-- table privileges before row policies. The web route's user-session upsert
-- (POST /api/onboarding/complete) was therefore denied, stranding every user
-- at /onboarding: both "Get a demo" and "Skip demo" call it first. SELECT is
-- already covered by the schema-wide grant; the insert-own policy stays the
-- row-level authorization check.

grant insert on table public.user_onboarding to authenticated;
