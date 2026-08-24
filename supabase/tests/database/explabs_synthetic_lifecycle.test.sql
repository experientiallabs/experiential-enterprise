begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- The classifier: monitored-mailbox plus-aliases, example.* domains,
-- epoch-suffixed fakes.
select ok(
  public.is_synthetic_email('silen+launch-check-1787309664@experientiallabs.ai'),
  'plus-alias is synthetic'
);
select ok(
  public.is_synthetic_email('verify-yc-1787377596@example.com'),
  'example.com placeholder is synthetic'
);
select ok(
  public.is_synthetic_email('launch-smoke-1787309664@experientiallabs.ai'),
  'epoch-suffixed fake mailbox is synthetic'
);
select ok(
  not public.is_synthetic_email('jane@acme.com')
  and not public.is_synthetic_email('admin@experientiallabs.ai')
  and not public.is_synthetic_email(null),
  'real addresses and null are not synthetic'
);
-- Plus-addressing is common at signup: only aliases of the monitored mailbox
-- are synthetic, or a real customer gets their keys revoked and account
-- deleted by expire_synthetic_accounts.
select ok(
  not public.is_synthetic_email('jane+explabs@gmail.com')
  and not public.is_synthetic_email('dev+platform@acme.com')
  and not public.is_synthetic_email('pat+silen@acme.com'),
  'a customer plus-alias of their own mailbox is not synthetic'
);
select ok(
  public.is_synthetic_email('SILEN+Launch-Check-1787309664@ExperientialLabs.ai'),
  'the monitored plus-alias is matched case-insensitively'
);

-- Notification suppression: with both Vault secrets seeded, a synthetic
-- signup enqueues nothing while a real signup enqueues Slack + PostHog.
create temporary table queue_baseline as
select count(*) as n from net.http_request_queue;

delete from vault.secrets
where name in ('slack_signup_webhook_url', 'posthog_project_key');
select vault.create_secret(
  'https://hooks.slack.example/services/T000/B000/test',
  'slack_signup_webhook_url'
);
select vault.create_secret('phc_test_project_key', 'posthog_project_key');

insert into auth.users (id, email, raw_app_meta_data)
values ('c1000000-0000-0000-0000-000000000001',
        'silen+lifecycle-check-1787000000@experientiallabs.ai',
        '{"provider": "email"}');

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  0::bigint,
  'synthetic signup pings neither Slack nor PostHog'
);

insert into auth.users (id, email, raw_app_meta_data)
values ('c1000000-0000-0000-0000-000000000002', 'human@acme.com', '{"provider": "email"}');

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  2::bigint,
  'real signup still pings Slack and PostHog'
);

-- Expiry: past-24h synthetic accounts are deleted; fresh synthetics and old
-- humans survive.
insert into auth.users (id, email, created_at) values
  ('c1000000-0000-0000-0000-000000000003',
   'silen+expired-suite-1786000000@experientiallabs.ai', now() - interval '25 hours'),
  ('c1000000-0000-0000-0000-000000000004',
   'silen+fresh-suite-1787111111@experientiallabs.ai', now() - interval '1 hour'),
  ('c1000000-0000-0000-0000-000000000005', 'veteran@acme.com', now() - interval '400 days'),
  ('c1000000-0000-0000-0000-000000000006',
   'jane+explabs@gmail.com', now() - interval '400 days');

select is(public.expire_synthetic_accounts(), 1, 'exactly the expired synthetic is deleted');
select is_empty(
  $$ select 1 from auth.users where id = 'c1000000-0000-0000-0000-000000000003' $$,
  'the past-24h synthetic account is gone'
);
select isnt_empty(
  $$ select 1 from auth.users where id = 'c1000000-0000-0000-0000-000000000004' $$,
  'a fresh synthetic account survives'
);
select isnt_empty(
  $$ select 1 from auth.users where id = 'c1000000-0000-0000-0000-000000000005' $$,
  'an old human account survives'
);
select isnt_empty(
  $$ select 1 from auth.users where id = 'c1000000-0000-0000-0000-000000000006' $$,
  'an old plus-addressed human account survives'
);

-- The hourly schedule exists wherever pg_cron does.
select is(
  (select count(*)::integer from cron.job where jobname = 'expire-synthetic-accounts'),
  1,
  'expire-synthetic-accounts is scheduled'
);

select * from finish();
rollback;
