-- user_onboarding's policies were the only ones in the schema built on raw
-- auth.uid(). The local stack's auth.uid() reads the legacy singular
-- request.jwt.claim.sub GUC, while its PostgREST publishes only the plural
-- request.jwt.claims JSON, so auth.uid() evaluates NULL there: completing
-- onboarding never became visible to the app and every "/" visit looped back
-- to /onboarding. Every other policy already uses authenticated_user_id(),
-- which coalesces both GUC forms; align these two with the house helper.
alter policy user_onboarding_select_own
  on public.user_onboarding
  using (user_id = public.authenticated_user_id());

alter policy user_onboarding_insert_own
  on public.user_onboarding
  with check (user_id = public.authenticated_user_id());
