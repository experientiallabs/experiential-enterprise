begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

select has_function(
  'public',
  'invoke_daily_summary',
  'the daily-summary job body exists as an invokable function'
);

select is(
  (select count(*) from cron.job
   where jobname = 'daily-usage-summary' and schedule = '0 5 * * *'),
  1::bigint,
  'the digest is scheduled nightly at 05:00 UTC (10pm PT during DST)'
);

create temporary table queue_baseline as
select count(*) as n from net.http_request_queue;

-- Hermetic: the schedule secrets must be absent for the silent-exit case.
delete from vault.secrets
where name in ('daily_summary_url', 'cron_secret');

-- No Vault secrets: the job body exits silently (local dev safety).
select public.invoke_daily_summary();

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  0::bigint,
  'without Vault secrets the job body enqueues nothing'
);

select vault.create_secret(
  'https://app.example.test/api/internal/daily-summary',
  'daily_summary_url'
);
select vault.create_secret('test-cron-secret', 'cron_secret');

select public.invoke_daily_summary();

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  1::bigint,
  'with Vault secrets the job body enqueues exactly one request'
);

select isnt_empty(
  $$
  select 1
  from net.http_request_queue
  where url = 'https://app.example.test/api/internal/daily-summary'
  $$,
  'the request targets the Vault-configured digest URL'
);

select isnt_empty(
  $$
  select 1
  from net.http_request_queue
  where url = 'https://app.example.test/api/internal/daily-summary'
    and headers ->> 'Authorization' = 'Bearer test-cron-secret'
  $$,
  'the request carries the Vault-configured bearer secret'
);

select * from finish();

rollback;
