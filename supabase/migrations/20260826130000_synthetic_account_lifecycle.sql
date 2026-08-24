-- Synthetic-account lifecycle (gw/analytics): keep test accounts out of the
-- signup channel and expire them automatically.
--
-- Synthetic accounts (smoke tests, E2E suites, launch checks) follow the
-- tests/synthetic-email.ts convention: plus-aliases of a monitored mailbox.
-- Two pre-convention shapes still occur and are classified explicitly:
-- example.* placeholder domains and epoch-suffixed fake @experientiallabs.ai
-- mailboxes. Three behaviors hang off the classifier:
--   1. notify_signup skips BOTH notifications (no #gw-signups ping, no
--      PostHog account_created) for synthetic signups.
--   2. The daily digest excludes them (isSyntheticEmail in
--      apps/web/lib/analytics/digest.ts mirrors this classifier — keep the
--      two in sync).
--   3. An hourly pg_cron job expires them ~24h after creation: api keys of
--      orgs left with only expiring members are revoked, then the auth user
--      is deleted (cleanup_deleted_auth_user removes memberships; orgs and
--      their usage/ledger rows are deliberately preserved).

create or replace function public.is_synthetic_email(in_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select in_email is not null
     and (in_email ~ '\+[^@]*@'
          or in_email ~* '@example\.(com|org|net)$'
          or in_email ~* '[0-9]{10,}@experientiallabs\.ai$');
$$;

revoke all on function public.is_synthetic_email(text) from public, anon, authenticated;
grant execute on function public.is_synthetic_email(text) to service_role;

-- Same body as 20260819205000 plus the synthetic gate at the top.
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
  -- Synthetic accounts are operational noise: no Slack ping, no PostHog
  -- account_created. The digest and admin insights then never see them.
  if public.is_synthetic_email(in_email) then
    return;
  end if;

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

-- Expire synthetic accounts ~24h after creation. plpgsql so a fresh Docker
-- stack (no auth.users yet at migrate time) can still create the function;
-- the body also no-ops in that state.
create or replace function public.expire_synthetic_accounts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired integer;
begin
  if to_regclass('auth.users') is null then
    return 0;
  end if;

  -- Revoke live api keys of orgs about to lose their last member: a test key
  -- must not outlive its test account. Orgs with any surviving (human or
  -- fresh-synthetic) member keep their keys.
  update public.api_keys keys
     set revoked_at = now()
   where keys.revoked_at is null
     and exists (
       select 1 from public.organization_members members
        where members.org_id = keys.org_id
     )
     and not exists (
       select 1
         from public.organization_members members
         join auth.users users on users.id = members.user_id
        where members.org_id = keys.org_id
          and not (
            public.is_synthetic_email(users.email)
            and users.created_at < now() - interval '24 hours'
          )
     );

  delete from auth.users users
   where public.is_synthetic_email(users.email)
     and users.created_at < now() - interval '24 hours';
  get diagnostics expired = row_count;
  return expired;
end;
$$;

revoke all on function public.expire_synthetic_accounts() from public, anon, authenticated;
grant execute on function public.expire_synthetic_accounts() to service_role;

-- Hourly at :15, wherever pg_cron exists (hosted and CLI stacks; guarded so
-- bare local stacks still migrate).
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; expire-synthetic-accounts not scheduled';
    return;
  end if;
  perform cron.schedule(
    'expire-synthetic-accounts',
    '15 * * * *',
    'select public.expire_synthetic_accounts()'
  );
end;
$$;
