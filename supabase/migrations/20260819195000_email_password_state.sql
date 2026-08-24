-- Whether an email's account carries a password credential at all.
--
-- Email-code (OTP) logins make passwordless the account's default state
-- forever, so two web routes need this distinction beyond what
-- signin_methods_for_email gives them (an OTP account still has an "email"
-- identity, indistinguishable from a password account by provider alone):
--   * /auth/signin — a password attempt on a passwordless account auto-sends
--     the sign-in code instead of answering "invalid credentials";
--   * /auth/password — a passwordless account sets its FIRST password
--     without a current-password proof (the session is the proof).
--
-- Security: service-role only, like signin_methods_for_email — exposing it
-- wider would hand out a per-account credential oracle. plpgsql so relation
-- resolution defers to the first call (auth.users appears after migrations
-- on the Docker stack), matching the existing lookup.
create or replace function public.email_has_password(check_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
    from auth.users users
    where lower(users.email) = lower(trim(check_email))
      and users.deleted_at is null
      and coalesce(users.encrypted_password, '') <> ''
  );
end;
$$;

revoke execute on function public.email_has_password(text)
  from public, anon, authenticated;
grant execute on function public.email_has_password(text) to service_role;
