begin;

create extension if not exists pgtap with schema extensions;

select plan(29);

-- Personal-org provisioning kill switch off is irrelevant here; orgs are
-- inserted directly, which still fires the $20 signup grant.

-- Shared endpoint parent for the serving rows that move the balance.
create or replace function pgtap_spend(in_org uuid, in_id uuid, in_cost numeric)
returns void language sql as $$
  insert into public.serving_requests
    (id, org_id, endpoint_id, endpoint_label, input_tokens, output_tokens, cost_usd, status)
  values (in_id, in_org,
    (select id from public.endpoints where org_id = in_org limit 1),
    'pgtap-ar', 10, 10, in_cost, 'ok');
$$;

-- ---------------------------------------------------------------------------
-- Org A: the happy path and every enqueue guard.

insert into public.organizations (id, slug, name)
values ('52000000-0000-0000-0000-00000000000a', 'pgtap-ar-a', 'pgTAP AR A');
insert into public.endpoints (id, org_id, name, policy)
values ('52000000-0000-0000-0000-0000000000ea', '52000000-0000-0000-0000-00000000000a',
        'pgtap-ar-endpoint-a', '{"kind": "static", "model": "gpt-5.5"}'::jsonb);

-- Defaults land on a bare settings row.
insert into public.org_auto_recharge_settings (org_id)
values ('52000000-0000-0000-0000-00000000000a');

select is(
  (select threshold_usd from public.org_auto_recharge_settings
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  10.000000::numeric, 'threshold defaults to $10');
select is(
  (select amount_usd from public.org_auto_recharge_settings
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  5.000000::numeric, 'amount defaults to the small $5');
select is(
  (select enabled from public.org_auto_recharge_settings
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  true, 'enabled defaults to on');

-- Bounds on the amount.
select throws_ok(
  $$insert into public.org_auto_recharge_settings (org_id, amount_usd)
    values ('52000000-0000-0000-0000-0000000000ff', 1)$$,
  '23514', null, 'an amount below the $5 floor is refused');
select throws_ok(
  $$insert into public.org_auto_recharge_settings (org_id, amount_usd)
    values ('52000000-0000-0000-0000-0000000000fe', 20000)$$,
  '23514', null, 'an amount above the ceiling is refused');

-- The settings table is service-role only: RLS on, no policies, so a member
-- read through PostgREST returns nothing and the Stripe handles never leak.
select is(
  (select relrowsecurity from pg_class where relname = 'org_auto_recharge_settings'),
  true, 'row level security is enabled on the settings table');
select is(
  (select count(*)::int from pg_policies where tablename = 'org_auto_recharge_settings'),
  0, 'the settings table has no member-facing policies (service-role only)');

-- Arm org A: raise the threshold above the current balance headroom and save a
-- card so the enqueue guards all pass except the balance one.
update public.org_auto_recharge_settings
   set threshold_usd = 15,
       stripe_customer_id = 'cus_A',
       stripe_payment_method_id = 'pm_A'
 where org_id = '52000000-0000-0000-0000-00000000000a';

-- Balance is $20 (the signup grant) >= $15: nothing to do.
select is(
  public.enqueue_auto_recharge_if_low('52000000-0000-0000-0000-00000000000a'),
  null::uuid, 'no attempt while the balance is above the threshold');
select is(
  (select count(*)::int from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  0, 'and no attempt row exists yet');

-- A debit that drops the balance below the threshold fires the settle-hook
-- trigger, which enqueues exactly one attempt.
select pgtap_spend('52000000-0000-0000-0000-00000000000a',
                   '52000000-0000-0000-0000-0000000000a1', 8);

select is(
  (select count(*)::int from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000a' and status = 'pending'),
  1, 'a balance drop below the threshold enqueues one attempt');
select is(
  (select amount_usd from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  5.000000::numeric, 'the attempt snapshots the configured amount');
select is(
  (select balance_at_enqueue_usd from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  12.000000::numeric, 'the attempt records the balance at enqueue (20 - 8)');

-- Idempotency: a second trigger while the attempt is live enqueues nothing.
select is(
  public.enqueue_auto_recharge_if_low('52000000-0000-0000-0000-00000000000a'),
  null::uuid, 'a live attempt blocks a second enqueue (no double charge)');
select is(
  (select count(*)::int from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  1, 'still exactly one attempt after the repeat trigger');

-- Cooldown: clear the live attempt, stamp a recent recharge, and the balance is
-- still low — the success cooldown holds off a re-charge.
delete from public.auto_recharge_attempts
 where org_id = '52000000-0000-0000-0000-00000000000a';
update public.org_auto_recharge_settings
   set last_recharge_at = now()
 where org_id = '52000000-0000-0000-0000-00000000000a';
select is(
  public.enqueue_auto_recharge_if_low('52000000-0000-0000-0000-00000000000a'),
  null::uuid, 'the success cooldown suppresses a re-charge');
select is(
  (select count(*)::int from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  0, 'no attempt is queued during the cooldown');

-- Failure back-off: at the failure cap, and within the failure cooldown, no
-- enqueue; once cleared, enqueue resumes.
update public.org_auto_recharge_settings
   set last_recharge_at = null, consecutive_failures = 3
 where org_id = '52000000-0000-0000-0000-00000000000a';
select is(
  public.enqueue_auto_recharge_if_low('52000000-0000-0000-0000-00000000000a'),
  null::uuid, 'the failure cap pauses auto-recharge');

update public.org_auto_recharge_settings
   set consecutive_failures = 1, last_failure_at = now()
 where org_id = '52000000-0000-0000-0000-00000000000a';
select is(
  public.enqueue_auto_recharge_if_low('52000000-0000-0000-0000-00000000000a'),
  null::uuid, 'a recent decline backs off before retrying');

update public.org_auto_recharge_settings
   set consecutive_failures = 0, last_failure_at = null
 where org_id = '52000000-0000-0000-0000-00000000000a';
select isnt(
  public.enqueue_auto_recharge_if_low('52000000-0000-0000-0000-00000000000a'),
  null::uuid, 'enqueue resumes once the guards clear');

-- ---------------------------------------------------------------------------
-- Settlement: success credits once (idempotent), failure counts once.

update public.auto_recharge_attempts
   set status = 'processing', stripe_payment_intent_id = 'pi_A_1'
 where org_id = '52000000-0000-0000-0000-00000000000a';

select is(
  public.record_auto_recharge_success(
    '52000000-0000-0000-0000-00000000000a', 'pi_A_1', 5, 'auto-recharge'),
  'credited', 'the first settlement credits');
select is(
  (select credit_granted_usd from public.organizations
    where id = '52000000-0000-0000-0000-00000000000a'),
  25.000000::numeric, 'the ledger gains the $5 recharge (20 + 5)');
select is(
  (select status from public.auto_recharge_attempts
    where stripe_payment_intent_id = 'pi_A_1'),
  'succeeded', 'the attempt closes as succeeded');

select is(
  public.record_auto_recharge_success(
    '52000000-0000-0000-0000-00000000000a', 'pi_A_1', 5, 'auto-recharge'),
  'replay', 'a replayed settlement converges to replay');
select is(
  (select credit_granted_usd from public.organizations
    where id = '52000000-0000-0000-0000-00000000000a'),
  25.000000::numeric, 'the replay does not credit a second time');

-- Failure: one processing attempt, counter bumps exactly once across retries.
insert into public.auto_recharge_attempts
  (org_id, amount_usd, balance_at_enqueue_usd, status, stripe_payment_intent_id)
values ('52000000-0000-0000-0000-00000000000a', 5, 0, 'processing', 'pi_A_fail');
update public.org_auto_recharge_settings
   set consecutive_failures = 0 where org_id = '52000000-0000-0000-0000-00000000000a';

select public.record_auto_recharge_failure(
  '52000000-0000-0000-0000-00000000000a', 'pi_A_fail', 'Your card was declined.');
select is(
  (select status from public.auto_recharge_attempts
    where stripe_payment_intent_id = 'pi_A_fail'),
  'failed', 'a declined attempt closes as failed');
select is(
  (select consecutive_failures from public.org_auto_recharge_settings
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  1, 'the anti-loop counter bumps on the failure');

select public.record_auto_recharge_failure(
  '52000000-0000-0000-0000-00000000000a', 'pi_A_fail', 'Your card was declined.');
select is(
  (select consecutive_failures from public.org_auto_recharge_settings
    where org_id = '52000000-0000-0000-0000-00000000000a'),
  1, 'a duplicate failure report does not double-count (webhook + poller)');

-- ---------------------------------------------------------------------------
-- Org B (disabled) and Org C (no card): a balance drop enqueues nothing.

insert into public.organizations (id, slug, name)
values ('52000000-0000-0000-0000-00000000000b', 'pgtap-ar-b', 'pgTAP AR B');
insert into public.endpoints (id, org_id, name, policy)
values ('52000000-0000-0000-0000-0000000000eb', '52000000-0000-0000-0000-00000000000b',
        'pgtap-ar-endpoint-b', '{"kind": "static", "model": "gpt-5.5"}'::jsonb);
insert into public.org_auto_recharge_settings
  (org_id, enabled, stripe_customer_id, stripe_payment_method_id)
values ('52000000-0000-0000-0000-00000000000b', false, 'cus_B', 'pm_B');
select pgtap_spend('52000000-0000-0000-0000-00000000000b',
                   '52000000-0000-0000-0000-0000000000b1', 15);
select is(
  (select count(*)::int from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000b'),
  0, 'a disabled org never enqueues');

insert into public.organizations (id, slug, name)
values ('52000000-0000-0000-0000-00000000000c', 'pgtap-ar-c', 'pgTAP AR C');
insert into public.endpoints (id, org_id, name, policy)
values ('52000000-0000-0000-0000-0000000000ec', '52000000-0000-0000-0000-00000000000c',
        'pgtap-ar-endpoint-c', '{"kind": "static", "model": "gpt-5.5"}'::jsonb);
insert into public.org_auto_recharge_settings (org_id, enabled)
values ('52000000-0000-0000-0000-00000000000c', true);
select pgtap_spend('52000000-0000-0000-0000-00000000000c',
                   '52000000-0000-0000-0000-0000000000c1', 15);
select is(
  (select count(*)::int from public.auto_recharge_attempts
    where org_id = '52000000-0000-0000-0000-00000000000c'),
  0, 'an org with no saved card never enqueues');

select * from finish();

rollback;
