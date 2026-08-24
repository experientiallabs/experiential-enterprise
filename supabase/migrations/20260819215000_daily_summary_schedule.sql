-- Schedule the nightly usage digest (ANLX-P4): pg_cron invokes the
-- CRON-secret-guarded platform route every night with no CI dependency.
--
-- 05:00 UTC = 10pm PT during daylight time (launch is August). This drifts
-- to 9pm PT when DST ends in November; deliberately left fixed-UTC —
-- revisit then rather than encoding timezone math into a cron expression.

-- pg_cron ships on hosted Supabase and the CLI/Docker images but is absent
-- from some local stacks; guard so the migration applies everywhere and the
-- schedule attaches wherever the extension exists.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end;
$$;

-- The job body, kept in one invokable function so pgTAP can drive it
-- directly and the cron command stays a one-liner. Reads the target URL and
-- bearer secret from Vault; with either absent it exits silently (local dev
-- safety — the digest simply never fires). pg_net only queues here; its
-- worker sends after commit.
create or replace function public.invoke_daily_summary()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  summary_url text;
  bearer_secret text;
begin
  select secrets.decrypted_secret into summary_url
  from vault.decrypted_secrets secrets
  where secrets.name = 'daily_summary_url';
  select secrets.decrypted_secret into bearer_secret
  from vault.decrypted_secrets secrets
  where secrets.name = 'cron_secret';
  if summary_url is null or bearer_secret is null then
    return;
  end if;
  perform net.http_post(
    url := summary_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || bearer_secret
    )
  );
end;
$$;

revoke all on function public.invoke_daily_summary()
  from public, anon, authenticated;

do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed; daily-usage-summary schedule not attached';
    return;
  end if;
  -- cron.schedule upserts by job name, so re-running this migration (or a
  -- redeploy) never duplicates the job.
  perform cron.schedule(
    'daily-usage-summary',
    '0 5 * * *',
    'select public.invoke_daily_summary()'
  );
end;
$$;
