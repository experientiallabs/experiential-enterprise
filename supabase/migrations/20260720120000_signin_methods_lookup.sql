-- Sign-in method lookup for the unified /signin action.
--
-- The single "Sign in" button both authenticates existing accounts and
-- creates first-time ones, so after a failed password attempt the web layer
-- must know which of three states the address is in: password account (wrong
-- password), OAuth-only account (no password identity to check), or no
-- account (offer creation). GoTrue's admin JS API has no exact email lookup,
-- so this definer function reads auth directly.
--
-- Security: the function is callable ONLY by the service role. Exposing it to
-- anon would hand out an account-existence oracle; the web layer decides what
-- to disclose per response.
-- plpgsql, not sql: GoTrue creates auth.users AFTER migrations run on the
-- Docker stack, and a sql-language body resolves relations at creation time.
-- plpgsql defers resolution to the first call, like provision_signup_org.
create or replace function public.signin_methods_for_email(check_email text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (
    select coalesce(
      array_agg(distinct identities.provider order by identities.provider),
      '{}'
    )
    from auth.users users
    join auth.identities identities on identities.user_id = users.id
    where lower(users.email) = lower(trim(check_email))
      and users.deleted_at is null
  );
end;
$$;

revoke execute on function public.signin_methods_for_email(text)
  from public, anon, authenticated;
grant execute on function public.signin_methods_for_email(text) to service_role;
