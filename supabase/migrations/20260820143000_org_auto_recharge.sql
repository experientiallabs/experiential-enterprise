-- Auto-recharge (gw-billing BC-P4): when an org's platform-funded credit
-- balance drops below a threshold, charge its saved card off-session for a
-- small top-up so serving never stalls at $0. Opt-in by default at the point
-- a card is first saved, adjustable and disable-able from /credits.
--
-- Shape:
--   org_auto_recharge_settings          one row per org that ever saved a card;
--                                       enabled/threshold/amount + the Stripe
--                                       customer + payment-method handles and a
--                                       failure counter (a declined card must
--                                       not loop-charge)
--   auto_recharge_attempts              one row per recharge; a partial unique
--                                       index caps it at ONE active (pending or
--                                       processing) attempt per org, which is
--                                       the double-charge guard
--   enqueue_auto_recharge_if_low(org)   the money-path hook: locks the settings
--                                       row, re-reads the balance, and enqueues
--                                       exactly one attempt when every guard
--                                       passes (enabled, saved card, below
--                                       threshold, cooldown elapsed, not already
--                                       recharging, failures not tripped)
--   track_org_balance_auto_recharge     AFTER-UPDATE trigger on organizations:
--                                       every debit already funnels through the
--                                       spend counters, so a balance drop is the
--                                       single settle signal — no second money
--                                       pipeline
--   record_auto_recharge_success(...)   atomic credit + attempt close + settings
--                                       reset, idempotent on the PaymentIntent id
--   record_auto_recharge_failure(...)   marks the attempt failed and bumps the
--                                       consecutive-failure counter (anti-loop)
--
-- The DB never talks to Stripe: it only decides "this org is low and opted in"
-- and queues the intent. The web app's off-session PaymentIntent turns a queued
-- attempt into a charge, and the Stripe webhook (payment_intent.succeeded /
-- payment_intent.payment_failed) settles it back through the two record_*
-- functions. Credits still only ever appear as a credit_ledger row, idempotent
-- on (source, source_ref) exactly like a manual top-up.

-- ---------------------------------------------------------------------------
-- 1. Per-org settings.

create table public.org_auto_recharge_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- Opt-out lives here; the UI default is "checked", but an org only gets a row
  -- once it saves a card, and it can turn the row off without losing the card.
  enabled boolean not null default true,
  -- Charge when balance (credit_granted_usd - billable_spend_usd) < threshold.
  threshold_usd numeric(14, 6) not null default 10 check (threshold_usd >= 0),
  -- How much to add per recharge. Bounded like a manual top-up (>= the $5 floor
  -- so card-fee overhead stays sane); the default is a deliberately small $5.
  amount_usd numeric(14, 6) not null default 5 check (amount_usd >= 5 and amount_usd <= 10000),
  -- Stripe handles for the off-session charge. Both null until a card is saved
  -- through Checkout with setup_future_usage=off_session; enqueue refuses while
  -- either is null (nothing could process the attempt). Server-internal: the
  -- settings API view must never serialize these.
  stripe_customer_id text,
  stripe_payment_method_id text,
  -- Where the "we recharged you" email goes; captured from the Checkout
  -- customer email at save time. Null means best-effort skip, never a failure.
  notify_email text,
  last_recharge_at timestamptz,
  -- A declined card must not retry on the next request. Every failure bumps the
  -- counter and stamps the time; enqueue backs off for FAILURE_COOLDOWN and
  -- pauses entirely at MAX_CONSECUTIVE_FAILURES until the org re-saves settings
  -- (which resets the counter). A success resets it to zero.
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_failure_at timestamptz,
  last_failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.org_auto_recharge_settings is
  'Per-org auto-recharge configuration and Stripe off-session handles. One row per org that ever saved a card. Writes are service-role only (checkout webhook + admin-gated settings API); mutation by members is blocked by RLS having no write policy.';
comment on column public.org_auto_recharge_settings.stripe_payment_method_id is
  'Saved off-session payment method. Server-internal (a provider resource id): the settings API returns has_payment_method, never this value.';

alter table public.org_auto_recharge_settings enable row level security;

-- No policies on purpose: every read and write goes through the service role
-- (the settings API sanitizes the payload and gates on org-admin; the checkout
-- webhook persists the saved card). A member querying PostgREST directly gets
-- nothing, which keeps the Stripe handles off the wire entirely.

-- ---------------------------------------------------------------------------
-- 2. The attempt queue.

create table public.auto_recharge_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Snapshot of settings.amount_usd at enqueue: the charge is what the org
  -- agreed to when it dropped low, not whatever the settings say when the
  -- poller finally runs.
  amount_usd numeric(14, 6) not null check (amount_usd > 0),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  -- Set when the poller creates the off-session PaymentIntent; the webhook
  -- matches the settlement back to the attempt by this id.
  stripe_payment_intent_id text,
  -- Balance at enqueue, for the audit trail and the recharge email context.
  balance_at_enqueue_usd numeric(14, 6) not null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index auto_recharge_attempts_org_created_idx
  on public.auto_recharge_attempts (org_id, created_at desc);

-- At most one live attempt per org. This is the double-charge guard: a second
-- low-balance trigger firing while a recharge is pending or processing hits
-- this index and is swallowed, so concurrent debits never queue two charges.
create unique index auto_recharge_attempts_one_active
  on public.auto_recharge_attempts (org_id)
  where status in ('pending', 'processing');

comment on table public.auto_recharge_attempts is
  'One row per auto-recharge. The partial unique index auto_recharge_attempts_one_active caps live attempts at one per org (the double-charge guard). Service-role only; no RLS policies.';

alter table public.auto_recharge_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- 3. The enqueue decision: lock, re-check, queue one.

create function public.enqueue_auto_recharge_if_low(target_org uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Policy windows. Kept as literals (billing policy, not per-org config):
  --   success cooldown  — throttle after a successful recharge so a fast burn
  --                       cannot loop-charge within the window
  --   failure cooldown  — back-off after a decline before any retry
  --   max failures      — hard pause; the org must re-save settings to resume
  success_cooldown constant interval := interval '15 minutes';
  failure_cooldown constant interval := interval '24 hours';
  max_failures constant integer := 3;
  settings public.org_auto_recharge_settings%rowtype;
  balance numeric;
  attempt_id uuid;
begin
  -- Lock the settings row: the same discipline the money path uses so two
  -- concurrent low-balance triggers for one org serialize here and only one
  -- reaches the insert.
  select * into settings
    from public.org_auto_recharge_settings
   where org_id = target_org
   for update;
  if not found then
    return null;              -- org never opted in / saved a card
  end if;
  if not settings.enabled then
    return null;
  end if;
  if settings.stripe_customer_id is null or settings.stripe_payment_method_id is null then
    return null;              -- nothing could process the attempt
  end if;
  if settings.consecutive_failures >= max_failures then
    return null;              -- paused until the org re-saves settings
  end if;
  if settings.last_failure_at is not null
     and settings.last_failure_at > now() - failure_cooldown then
    return null;              -- backing off after a decline
  end if;
  if settings.last_recharge_at is not null
     and settings.last_recharge_at > now() - success_cooldown then
    return null;              -- throttled after a recent recharge
  end if;

  -- Re-read the balance under the lock (never trust a value computed before
  -- the settle committed).
  select orgs.credit_granted_usd - orgs.billable_spend_usd
    into balance
    from public.organizations orgs
   where orgs.id = target_org;
  if balance is null or balance >= settings.threshold_usd then
    return null;
  end if;

  -- One live attempt per org: a pending/processing row already covers this.
  begin
    insert into public.auto_recharge_attempts
        (org_id, amount_usd, balance_at_enqueue_usd)
      values (target_org, settings.amount_usd, balance)
      returning id into attempt_id;
  exception when unique_violation then
    return null;              -- already recharging
  end;
  return attempt_id;
end;
$$;

revoke all on function public.enqueue_auto_recharge_if_low(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The settle hook: a balance drop is the only signal.
--
-- Every debit in the system ends at apply_org_spend_delta -> UPDATE
-- organizations, so a trigger on the balance columns is the post-settle hook
-- without a second pipeline. It fires only when the balance actually dropped
-- (skips top-ups and the recharge credit itself, so the credit can never
-- re-arm the trigger), then defers every real decision to the locked,
-- guarded enqueue function above.

create function public.track_org_balance_auto_recharge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.credit_granted_usd - new.billable_spend_usd)
     < (old.credit_granted_usd - old.billable_spend_usd) then
    perform public.enqueue_auto_recharge_if_low(new.id);
  end if;
  return null;
end;
$$;

create trigger track_org_balance_auto_recharge
after update of billable_spend_usd, credit_granted_usd on public.organizations
for each row execute function public.track_org_balance_auto_recharge();

-- ---------------------------------------------------------------------------
-- 5. Settlement back from Stripe.
--
-- Success is the one place an auto-recharge becomes credit: a credit_ledger
-- row (source 'stripe', source_ref the PaymentIntent id) idempotent on the
-- unique (source, source_ref) index, the attempt closed, and the settings
-- reset — all in one transaction. A replayed webhook converges to 'replay'.

create function public.record_auto_recharge_success(
  in_org uuid,
  in_payment_intent_id text,
  in_amount_usd numeric,
  in_created_by text default 'auto-recharge'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  outcome text := 'credited';
begin
  -- Lock the settings row so a racing failure record cannot interleave.
  perform 1 from public.org_auto_recharge_settings
   where org_id = in_org for update;

  begin
    insert into public.credit_ledger
        (org_id, entry_type, amount_usd, reason, source, source_ref, created_by)
      values
        (in_org, 'topup', in_amount_usd, 'Auto-recharge', 'stripe',
         in_payment_intent_id, in_created_by);
  exception when unique_violation then
    outcome := 'replay';
  end;

  update public.auto_recharge_attempts
     set status = 'succeeded', updated_at = now()
   where stripe_payment_intent_id = in_payment_intent_id
     and status in ('pending', 'processing');

  update public.org_auto_recharge_settings
     set last_recharge_at = now(),
         consecutive_failures = 0,
         last_failure_at = null,
         last_failure_message = null,
         updated_at = now()
   where org_id = in_org;

  return outcome;
end;
$$;

revoke all on function public.record_auto_recharge_success(uuid, text, numeric, text)
  from public, anon, authenticated;

create function public.record_auto_recharge_failure(
  in_org uuid,
  in_payment_intent_id text,
  in_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  transitioned integer;
begin
  -- Transition the attempt exactly once. The processor (synchronous decline)
  -- and the payment_intent.payment_failed webhook can both report the same
  -- failure; keying on the PaymentIntent id and only counting a real
  -- pending/processing -> failed transition keeps the anti-loop counter from
  -- double-bumping on that duplicate.
  update public.auto_recharge_attempts
     set status = 'failed',
         error_message = in_message,
         updated_at = now()
   where in_payment_intent_id is not null
     and stripe_payment_intent_id = in_payment_intent_id
     and status in ('pending', 'processing');
  get diagnostics transitioned = row_count;

  if transitioned > 0 then
    update public.org_auto_recharge_settings
       set consecutive_failures = consecutive_failures + 1,
           last_failure_at = now(),
           last_failure_message = in_message,
           updated_at = now()
     where org_id = in_org;
  end if;
end;
$$;

revoke all on function public.record_auto_recharge_failure(uuid, text, text)
  from public, anon, authenticated;
