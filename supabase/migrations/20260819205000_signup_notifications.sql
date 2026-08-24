-- Signup notifications: Slack ping + PostHog capture for every new account.
--
-- The insert into auth.users is the only choke point that sees both
-- email/password and OAuth signups (the OAuth callback only gates after the
-- fact), so this rides a SECOND after-insert trigger next to
-- provision_signup_org — that trigger is never modified here. Delivery is
-- async pg_net, secrets come from Supabase Vault, and the trigger body
-- swallows every failure: a lost ping is acceptable, a lost signup is not.
-- With no Vault secrets seeded (local dev, previews, CI) the trigger does
-- nothing.

create extension if not exists pg_net with schema extensions;

-- net.http_request_queue stores outbound bodies and URLs verbatim — the
-- Slack webhook URL and the PostHog key ride through it — and pg_net itself
-- grants ALL on its tables to PUBLIC, so every client role could read the
-- queue. Definer functions (owner) and the pg_net worker are unaffected.
revoke all on all tables in schema net from public, anon, authenticated;

-- The two outbound notification requests for one new auth user. Split from
-- the trigger function so the swallow-everything wrapper there stays a
-- one-liner and pgTAP can prove the wrapper by swapping in a raising body.
-- Each request is gated on its own Vault secret so either destination can be
-- configured alone. pg_net only queues here (net.http_request_queue); its
-- worker sends after commit, keeping signup latency flat.
create or replace function public.signup_notification_requests(
  in_user_id uuid,
  in_email text,
  in_provider text,
  in_invited boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  slack_webhook_url text;
  posthog_key text;
begin
  select secrets.decrypted_secret into slack_webhook_url
  from vault.decrypted_secrets secrets
  where secrets.name = 'slack_signup_webhook_url';
  if slack_webhook_url is not null then
    perform net.http_post(
      url := slack_webhook_url,
      body := jsonb_build_object(
        'text',
        format(
          'New account created — %s (%s%s)',
          coalesce(in_email, 'no email'),
          coalesce(in_provider, 'unknown provider'),
          case when in_invited then ', invited' else '' end
        )
      )
    );
  end if;

  select secrets.decrypted_secret into posthog_key
  from vault.decrypted_secrets secrets
  where secrets.name = 'posthog_project_key';
  if posthog_key is not null then
    -- distinct_id rides at the top level per the documented capture contract
    -- (https://posthog.com/docs/api/capture: "Every event request must
    -- contain an api_key, distinct_id, and event field") and is mirrored
    -- into properties, the legacy location PostHog also accepts and strips
    -- on ingest — identity attaches on either ingestion path.
    perform net.http_post(
      url := 'https://us.i.posthog.com/capture/',
      body := jsonb_build_object(
        'api_key', posthog_key,
        'event', 'account_created',
        'distinct_id', in_user_id::text,
        'properties', jsonb_build_object(
          'distinct_id', in_user_id::text,
          'email', in_email,
          'provider', in_provider,
          'invited', in_invited,
          '$set', jsonb_build_object('email', in_email)
        )
      )
    );
  end if;
end;
$$;

revoke all on function public.signup_notification_requests(uuid, text, text, boolean)
  from public, anon, authenticated;

create or replace function public.notify_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Nothing in here may abort the signup transaction; even a missing helper
  -- or a Vault permission error collapses to "no ping" rather than "no user".
  -- The warning keeps genuine misconfiguration visible in the database logs
  -- without weakening that guarantee.
  begin
    perform public.signup_notification_requests(
      new.id,
      new.email,
      new.raw_app_meta_data ->> 'provider',
      nullif(new.raw_user_meta_data ->> 'invite_token', '') is not null
    );
  exception
    when others then
      raise warning 'notify_signup: notification skipped for user %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.notify_signup() from public, anon, authenticated;

-- Same Docker-ordering pattern as ensure_signup_org_trigger: auth.users does
-- not exist yet when migrations run on a fresh Docker stack (GoTrue boots
-- after supabase-migrate), so seed.sql re-invokes this once it does. On
-- Supabase CLI and hosted branches auth.users predates migrations and the
-- call below attaches the trigger immediately.
create or replace function public.ensure_notify_signup_trigger()
returns void
language plpgsql
as $$
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users does not exist yet; notify_signup trigger deferred to seed';
    return;
  end if;
  drop trigger if exists notify_signup on auth.users;
  create trigger notify_signup
    after insert on auth.users
    for each row execute function public.notify_signup();
end;
$$;

revoke all on function public.ensure_notify_signup_trigger()
  from public, anon, authenticated;
grant execute on function public.ensure_notify_signup_trigger()
  to service_role;

select public.ensure_notify_signup_trigger();
