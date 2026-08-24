-- Rotate an account's credentials when its email is first verified: revoke every
-- api key the (still-unverified) owner minted and delete every session created
-- before verification.
--
-- Closes a credit-theft chain (adversarial review of PR #599) WITHOUT changing
-- the pre-grant UX: the public instant-signup (POST /api/signup/instant) and
-- zero-click /signup log the user in and grant the $20 welcome credit
-- IMMEDIATELY (credits shown at once, just LOCKED by the P1025 spend gate until
-- the email is verified). But those endpoints create an account for ANY typed
-- email with no proof of inbox ownership, so an attacker could instant-sign-up a
-- victim's address, keep the returned `xpl_` key (or a /signup session), and
-- drain the $20 the moment the real owner clicked the "verify to use your
-- credits" email and the gate opened.
--
-- Fix: verification is the moment inbox ownership is finally proven, so it
-- REPLACES every pre-verification credential. On the first transition of
-- auth.users.email_confirmed_at to non-null:
--   * every api key the owner minted while unverified (created_by = the owner)
--     is revoked -- an attacker's retained key dies exactly when the real owner
--     verifies; the verified owner mints a fresh, usable key from the dashboard;
--   * every session established before this verification is deleted -- only the
--     session created by the verifying click (the inbox owner) survives, so a
--     pre-verification /signup session cannot mint a fresh key and spend once the
--     gate opens.
-- The welcome grant stays applied at signup (eager, gated) -- only the
-- credentials rotate.

create function public.rotate_credentials_on_verify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only on the FIRST confirmation: an INSERT already carrying
  -- email_confirmed_at (OAuth / emailed-code signups, verified at signup -- they
  -- have no pre-verification credentials to rotate) or an UPDATE transitioning
  -- it from null (an instant signup or /signup account verifying later).
  if new.email_confirmed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then
    return new;
  end if;
  -- Seeded/demo accounts manage their own keys; never rotate them. (The demo
  -- seed repoints explabs.seed_admin_email at each demo email as it inserts it.)
  if new.email in (
    nullif(pg_catalog.current_setting('explabs.seed_admin_email', true), ''),
    nullif(pg_catalog.current_setting('explabs.demo_seed_email', true), '')
  ) then
    return new;
  end if;

  -- Revoke every key THIS owner minted while unverified. Scoped to created_by so
  -- verifying as a newly-invited admin of an ESTABLISHED org never revokes that
  -- org's existing keys (they were created by other, already-verified admins).
  update public.api_keys
     set revoked_at = pg_catalog.now()
   where created_by = new.id
     and revoked_at is null;

  -- Delete any session created before this verification. The verifying click's
  -- session is created ~now (>= email_confirmed_at); the margin keeps it while
  -- removing older ones (e.g. a zero-click /signup session for whoever typed the
  -- address).
  delete from auth.sessions
   where user_id = new.id
     and created_at < new.email_confirmed_at - pg_catalog.interval '5 seconds';

  return new;
end;
$$;

revoke all on function public.rotate_credentials_on_verify() from public, anon, authenticated;

-- auth.users is owned by GoTrue and may not exist when migrations run on a fresh
-- Docker stack (GoTrue boots after supabase-migrate), so seed.sql re-invokes
-- this once it does. On Supabase CLI and hosted branches auth.users predates
-- migrations and the call below attaches immediately.
create or replace function public.ensure_rotate_credentials_trigger()
returns void
language plpgsql
as $$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users does not exist yet; credential-rotation trigger deferred to seed';
    return;
  end if;
  drop trigger if exists rotate_credentials_on_verify on auth.users;
  create trigger rotate_credentials_on_verify
    after insert or update of email_confirmed_at on auth.users
    for each row execute function public.rotate_credentials_on_verify();
end;
$$;

revoke all on function public.ensure_rotate_credentials_trigger()
  from public, anon, authenticated;
grant execute on function public.ensure_rotate_credentials_trigger()
  to service_role;

select public.ensure_rotate_credentials_trigger();
