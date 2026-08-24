begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

-- Client roles must never read the queue: it carries the webhook URL and
-- PostHog key verbatim in queued request bodies.
select ok(
  not has_table_privilege('anon', 'net.http_request_queue', 'select'),
  'anon cannot read the pg_net request queue'
);
select ok(
  not has_table_privilege('authenticated', 'net.http_request_queue', 'select'),
  'authenticated cannot read the pg_net request queue'
);

select has_trigger(
  'auth',
  'users',
  'notify_signup',
  'auth.users insert has the signup-notification trigger'
);

-- All queue assertions are deltas against this snapshot: pg_net's worker
-- cannot see rows enqueued inside this (rolled back) transaction, but rows
-- from other committed activity may still be sitting in the queue.
create temporary table queue_baseline as
select count(*) as n from net.http_request_queue;

-- The notification secrets must be absent for the no-secret case; previews
-- and local stacks never seed them, but stay hermetic anyway (rolled back).
delete from vault.secrets
where name in ('slack_signup_webhook_url', 'posthog_project_key');

-- Case 1: no Vault secrets — the signup inserts cleanly and enqueues nothing.
select set_config('explabs.seed_admin_email', 'no-secrets@example.com', true);
insert into auth.users (id, email, raw_app_meta_data)
values ('b1000000-0000-0000-0000-000000000001', 'no-secrets@example.com', '{"provider": "email"}');

select isnt_empty(
  $$ select 1 from auth.users where id = 'b1000000-0000-0000-0000-000000000001' $$,
  'no secrets: the signup insert itself succeeds'
);

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  0::bigint,
  'no secrets: nothing is enqueued'
);

-- Case 2: both secrets seeded — one OAuth + invited signup enqueues exactly
-- the Slack ping and the PostHog capture.
select vault.create_secret(
  'https://hooks.slack.example/services/T000/B000/test',
  'slack_signup_webhook_url'
);
select vault.create_secret('phc_test_project_key', 'posthog_project_key');

select set_config('explabs.seed_admin_email', 'invited@example.com', true);
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
values (
  'b1000000-0000-0000-0000-000000000002',
  'invited@example.com',
  '{"provider": "google"}',
  '{"invite_token": "tok-123"}'
);

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  2::bigint,
  'secrets seeded: the signup enqueues exactly two requests'
);

select isnt_empty(
  $$
  select 1
  from net.http_request_queue
  where url = 'https://hooks.slack.example/services/T000/B000/test'
    and convert_from(body, 'utf8')
      like '%New account created — invited@example.com (google, invited)%'
  $$,
  'the Slack ping carries the email, provider, and invited marker on one line'
);

select isnt_empty(
  $$
  select 1
  from net.http_request_queue
  where url = 'https://us.i.posthog.com/capture/'
    and (convert_from(body, 'utf8'))::jsonb ->> 'event' = 'account_created'
    and (convert_from(body, 'utf8'))::jsonb ->> 'distinct_id'
      = 'b1000000-0000-0000-0000-000000000002'
    and (convert_from(body, 'utf8'))::jsonb -> 'properties' ->> 'distinct_id'
      = 'b1000000-0000-0000-0000-000000000002'
    and (convert_from(body, 'utf8'))::jsonb -> 'properties' ->> 'provider' = 'google'
    and ((convert_from(body, 'utf8'))::jsonb -> 'properties' ->> 'invited')::boolean
  $$,
  'the PostHog capture is account_created keyed by the new user uuid'
);

-- A plain email signup (no invite token) reads as not-invited.
select set_config('explabs.seed_admin_email', 'plain@example.com', true);
insert into auth.users (id, email, raw_app_meta_data)
values ('b1000000-0000-0000-0000-000000000003', 'plain@example.com', '{"provider": "email"}');

select isnt_empty(
  $$
  select 1
  from net.http_request_queue
  where convert_from(body, 'utf8')
    like '%New account created — plain@example.com (email)%'
  $$,
  'an uninvited email signup pings without the invited marker'
);

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  4::bigint,
  'each notified signup enqueues its two requests'
);

-- Case 3: a raising notification body must never abort the signup. The
-- trigger wraps the helper call in an exception handler; swap the helper for
-- one that raises and prove the insert still lands. Rolled back with
-- everything else.
create or replace function public.signup_notification_requests(
  in_user_id uuid,
  in_email text,
  in_provider text,
  in_invited boolean
)
returns void
language plpgsql
as $$
begin
  raise exception 'notification failure injected by pgTAP';
end;
$$;

select set_config('explabs.seed_admin_email', 'raising@example.com', true);
insert into auth.users (id, email, raw_app_meta_data)
values ('b1000000-0000-0000-0000-000000000004', 'raising@example.com', '{"provider": "email"}');

select isnt_empty(
  $$ select 1 from auth.users where id = 'b1000000-0000-0000-0000-000000000004' $$,
  'a raising notification body does not abort the signup insert'
);

select is(
  (select count(*) from net.http_request_queue) - (select n from queue_baseline),
  4::bigint,
  'the raising body enqueued nothing'
);

select is(
  (select count(*) from public.organization_members
   where user_id in (
     'b1000000-0000-0000-0000-000000000001',
     'b1000000-0000-0000-0000-000000000002',
     'b1000000-0000-0000-0000-000000000004'
   )),
  0::bigint,
  'the sibling provisioning trigger was untouched (seed skip honored)'
);

select * from finish();

rollback;
