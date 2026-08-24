-- Billing policy for the gateway launch: replaces the STUB bodies of the
-- three billing-owned seams shipped by the gateway runtime migration
-- (20260819190000) with billing's real rules, per plan gw-billing-credits
-- packets BC-P6 (spend authorization) and BC-P7 (settlement). Signatures and
-- grants are unchanged, and the two load-bearing stub contracts survive:
--
--   * gateway_spend_policy_check's balance term still subtracts outstanding
--     host_managed reservations (the concurrent-reservation pgTAP test pins
--     it), including its one-honest-overdraft semantics: a strictly positive
--     available balance admits, at or below zero blocks; and
--   * callers hold the organizations row lock before invoking the check, so
--     check-then-reserve stays serialized (the cap sums below rely on it the
--     same way the balance term does).
--
-- Rules installed here (product decisions, quoted in the plan):
--
--   * Free-credit funded = the org has zero 'topup' credit_ledger rows.
--     Launch default while Q19 (when free-credit caps lift) is decided in
--     another chat; gateway_org_free_credit_funded is the single swap point.
--     Admin override (coordinator ruling R11): setting
--     organizations.free_credit_caps_lifted_at forces the predicate false,
--     lifting the caps without a top-up (admin Orgs panel toggle).
--   * Free-credit-funded orgs get $50/day per org and $25/day per model on
--     the platform-funded lane (UTC day), on top of the balance gate. The
--     sums use charged-or-reserved semantics identical to the pinned per-key
--     cap in gateway_start_attempt: settled attempts count their settled
--     amount, dispatched attempts their reservation, bucketed by
--     budget_period_start. They deliberately read gateway_attempts rather
--     than gateway_usage_events: events key models by requested alias while
--     this check receives the exact model id, events lag settled-but-not-yet-
--     finalized waterfall attempts, and events cannot carry reservations.
--   * Reason codes org_daily_cap / model_daily_cap map to the reserved typed
--     errors P1014 / P1015 in gateway_start_attempt. (Billing's HTTP
--     authorize_spend surface names the org one 'daily_cap'; the SQL seam
--     keeps the P1014 scope name the runtime migration reserved.)
--   * Error copy is BC-P6's verbatim customer text, prefixed with the scope
--     tag the seam's message convention requires, with EXPLABS_WEBAPP_URL
--     links and the YC contact suffix for orgs holding an unexpired
--     yc_claims row.
--   * Settlement (BC-P7) is RATIFIED as shipped: debit platform credits at
--     the exact settled cost by bumping billable_spend_usd ONLY. spend_usd
--     stays untouched on purpose — recompute_org_spend cannot see gateway
--     rows, so a spend_usd contribution would be silently erased by the next
--     repair; the Overview reads gateway_usage_daily for gateway display.
--     No per-settlement credit_ledger rows either: the ledger is the
--     credit side (grants/top-ups/adjustments), and gateway_usage_events is
--     already the auditable debit-side record.
--   * Unknown-cost attempts — work delivered but no computable cost — bill
--     $0 and increment organizations.gateway_unknown_cost_attempts for admin
--     review ("no markup" forbids billing a guess). Zero-completion
--     insurance stays where int-P1 put it (gateway_settle_attempt /
--     gateway_reconcile_crashed settle at 0); this migration adds no second
--     application of it, only the review counter.

-- ---------------------------------------------------------------------------
-- 1. Policy state on organizations.

alter table public.organizations
  add column free_credit_caps_lifted_at pg_catalog.timestamptz,
  add column gateway_unknown_cost_attempts pg_catalog.int8 not null default 0
    check (gateway_unknown_cost_attempts >= 0);

comment on column public.organizations.free_credit_caps_lifted_at is
  'When set, a platform admin lifted the free-credit daily caps for this org: gateway_org_free_credit_funded returns false regardless of the ledger. Toggled from the admin Orgs panel (PUT /api/admin/orgs/{org_id}/free-credit-caps).';
comment on column public.organizations.gateway_unknown_cost_attempts is
  'Platform-funded gateway attempts that delivered output but had no computable cost, so they were billed $0 (no markup forbids billing a guess). Review signal for the admin Orgs panel; incremented by gateway_settle_billing.';

-- ---------------------------------------------------------------------------
-- 2. Indexes backing the per-dispatch policy reads (target < 10ms).

-- gateway_org_free_credit_funded probes for any topup row per dispatch.
create index credit_ledger_org_topup_idx
  on public.credit_ledger (org_id)
  where entry_type = 'topup';

-- The daily org/model cap sums read one org's host_managed attempts for one
-- budget period.
create index gateway_attempts_billing_period_idx
  on public.gateway_attempts (org_id, budget_period_start, exact_model_id)
  where billing_source = 'host_managed';

-- ---------------------------------------------------------------------------
-- 3. Internal helpers for the policy copy. No direct grants, like
--    gateway_attempt_cost_micro_usd.

create function public.gateway_webapp_url()
returns pg_catalog.text
language sql
stable
security definer
set search_path = ''
as $$
  -- Error copy prints self-correcting links. EXPLABS_WEBAPP_URL is an
  -- app-layer env var; deploys that need a different hostname set the
  -- app.explabs_webapp_url GUC, otherwise the launch hostname applies.
  select coalesce(
    nullif(pg_catalog.current_setting('app.explabs_webapp_url', true), ''),
    'https://platform.experientiallabs.ai'
  );
$$;

revoke all on function public.gateway_webapp_url()
  from public, anon, authenticated, service_role;

create function public.gateway_support_phone()
returns pg_catalog.text
language sql
stable
security definer
set search_path = ''
as $$
  -- Support phone for the YC-aware error copy. Kept in config rather
  -- than baked into the policy body (customer/deployment-specific
  -- details belong in config, not reusable core SQL). Same shape as
  -- gateway_webapp_url: deploys that need a different number set the
  -- app.explabs_support_phone GUC, otherwise the placeholder applies.
  select coalesce(
    nullif(pg_catalog.current_setting('app.explabs_support_phone', true), ''),
    '000-000-0000'
  );
$$;

revoke all on function public.gateway_support_phone()
  from public, anon, authenticated, service_role;

create function public.gateway_support_email()
returns pg_catalog.text
language sql
stable
security definer
set search_path = ''
as $$
  -- Support email for the YC-aware error copy. Config, not a baked
  -- literal, like gateway_webapp_url: deploys set the app.explabs_support_email
  -- GUC, otherwise the placeholder applies.
  select coalesce(
    nullif(pg_catalog.current_setting('app.explabs_support_email', true), ''),
    'support@example.com'
  );
$$;

revoke all on function public.gateway_support_email()
  from public, anon, authenticated, service_role;

create function public.gateway_org_yc_suffix(p_org_id pg_catalog.uuid)
returns pg_catalog.text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claimed pg_catalog.bool := false;
begin
  -- yc_claims ships in the BC-P5 packet, which may apply after this
  -- migration, so the read is guarded and dynamic. The column contract
  -- (org_id, expires_at, revoked_at) is pinned by the gw-billing-credits
  -- plan; make this a static reference once BC-P5 is merged everywhere.
  if pg_catalog.to_regclass('public.yc_claims') is not null then
    execute 'select exists (
        select 1 from public.yc_claims claims
        where claims.org_id = $1
          and claims.expires_at > pg_catalog.clock_timestamp()
          and claims.revoked_at is null
      )' into v_claimed using p_org_id;
  end if;
  if v_claimed then
    return ' You''re on the YC launch grant — text/call support at '
      || public.gateway_support_phone()
      || ' or email ' || public.gateway_support_email()
      || ' and we''ll sort you out.';
  end if;
  return '';
end;
$$;

revoke all on function public.gateway_org_yc_suffix(pg_catalog.uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The funding-source predicate (real rule replacing the stub).

create or replace function public.gateway_org_free_credit_funded(p_org_id pg_catalog.uuid)
returns pg_catalog.bool
language sql
stable
security definer
set search_path = ''
as $$
  -- Free-credit funded iff the org has never topped up (zero 'topup' ledger
  -- rows: launch default until the cross-chat Q19 decision lands; this
  -- predicate is the single swap point) and no admin lifted the caps.
  select (
    select orgs.free_credit_caps_lifted_at
      from public.organizations orgs
     where orgs.id = p_org_id
  ) is null
  and not exists (
    select 1 from public.credit_ledger ledger
    where ledger.org_id = p_org_id and ledger.entry_type = 'topup'
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. The spend policy check: balance gate (verbatim from the stub) plus the
--    free-credit daily caps and the verbose, YC-aware error copy.

create or replace function public.gateway_spend_policy_check(
  p_org_id pg_catalog.uuid,
  p_model pg_catalog.text,
  p_proposed_micro_usd pg_catalog.int8
)
returns table (
  allowed pg_catalog.bool,
  reason_code pg_catalog.text,
  message pg_catalog.text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance pg_catalog.numeric;
  v_outstanding pg_catalog.int8;
  v_available pg_catalog.numeric;
  v_proposed pg_catalog.int8 := coalesce(p_proposed_micro_usd, 0);
  v_period_start pg_catalog.timestamptz;
  v_org_spent pg_catalog.int8;
  v_model_spent pg_catalog.int8;
begin
  select orgs.credit_granted_usd - orgs.billable_spend_usd
    into v_balance
    from public.organizations orgs
   where orgs.id = p_org_id;
  if v_balance is null then
    return query select false, 'insufficient_credits'::pg_catalog.text,
      'insufficient_credits: the organization does not exist'::pg_catalog.text;
    return;
  end if;
  -- Reservation-aware balance term, unchanged from the runtime migration:
  -- pgTAP pins that dispatched host_managed worst cases already count, and
  -- that a strictly positive available balance admits (one honest overdraft).
  select coalesce(pg_catalog.sum(attempts.budget_reserved_micro_usd), 0)
    into v_outstanding
    from public.gateway_attempts attempts
   where attempts.org_id = p_org_id
     and attempts.state = 'dispatched'
     and attempts.billing_source = 'host_managed';
  v_available := v_balance - (v_outstanding::pg_catalog.numeric / 1000000);
  if v_available <= 0 then
    -- The printed balance is the available figure this gate reads (ledger
    -- balance minus outstanding reservations), so the message never claims
    -- credits the very next settlement is about to consume.
    return query select false, 'insufficient_credits'::pg_catalog.text,
      ('insufficient_credits: Your organization is out of platform credits '
       || '(balance: $' || pg_catalog.to_char(v_available, 'FM999999990.00')
       || '). Add credits at ' || public.gateway_webapp_url()
       || '/credits — top-ups start at $5. Requests using your own provider '
       || 'keys (BYOK) are unaffected.'
       || public.gateway_org_yc_suffix(p_org_id))::pg_catalog.text;
    return;
  end if;

  if not public.gateway_org_free_credit_funded(p_org_id) then
    return query select true, null::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;

  -- Free-credit daily caps: $50/day per org, $25/day per model (UTC day,
  -- platform-funded lane only). Charged-or-reserved, the same accounting the
  -- pinned per-key cap uses: settled attempts at their settled amount
  -- (insurance already applied), in-flight attempts at their reservation.
  v_period_start := pg_catalog.date_trunc(
    'day', pg_catalog.clock_timestamp() at time zone 'UTC'
  ) at time zone 'UTC';
  select
    coalesce(pg_catalog.sum(
      case when attempts.state = 'dispatched'
        then attempts.budget_reserved_micro_usd
        else coalesce(attempts.budget_settled_micro_usd, 0)
      end), 0),
    coalesce(pg_catalog.sum(
      case when attempts.state = 'dispatched'
        then attempts.budget_reserved_micro_usd
        else coalesce(attempts.budget_settled_micro_usd, 0)
      end) filter (where attempts.exact_model_id = p_model), 0)
    into v_org_spent, v_model_spent
    from public.gateway_attempts attempts
   where attempts.org_id = p_org_id
     and attempts.billing_source = 'host_managed'
     and attempts.budget_period_start = v_period_start;

  -- Hard caps admit a worst case that fits exactly and refuse the first
  -- micro-dollar past it (no cap overdraft; the honest overdraft is the
  -- balance gate's semantics, not the caps').
  if v_org_spent + v_proposed > 50000000 then
    return query select false, 'org_daily_cap'::pg_catalog.text,
      ('org_daily_cap: Free-credit accounts are limited to $50/day (you''ve '
       || 'used $'
       || pg_catalog.to_char(
            v_org_spent::pg_catalog.numeric / 1000000, 'FM999999990.00')
       || ' today; resets at 00:00 UTC). Top up at '
       || public.gateway_webapp_url()
       || '/credits to lift the limit, or contact support if you want it fixed.'
       || public.gateway_org_yc_suffix(p_org_id))::pg_catalog.text;
    return;
  end if;
  if v_model_spent + v_proposed > 25000000 then
    return query select false, 'model_daily_cap'::pg_catalog.text,
      ('model_daily_cap: Free-credit accounts are limited to $25/day per '
       || 'model (you''ve used $'
       || pg_catalog.to_char(
            v_model_spent::pg_catalog.numeric / 1000000, 'FM999999990.00')
       || ' on ' || p_model || ' today; resets at 00:00 UTC). No model is '
       || 'forbidden — switch models to keep going now, top up at '
       || public.gateway_webapp_url()
       || '/credits to lift the limit, or contact support if you want it fixed.'
       || public.gateway_org_yc_suffix(p_org_id))::pg_catalog.text;
    return;
  end if;

  return query select true, null::pg_catalog.text, null::pg_catalog.text;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Settlement: int-P1's debit rule ratified, plus the unknown-cost review
--    counter. Exactly-once is owned by the callers' attempt state machine
--    (gateway_settle_attempt / gateway_reconcile_crashed transition the
--    attempt row under its lock and invoke this once per transition; a
--    replayed settlement returns before reaching this function — pgTAP pins
--    no double-debit).

create or replace function public.gateway_settle_billing(
  p_org_id pg_catalog.uuid,
  p_request_id pg_catalog.text,
  p_attempt_id pg_catalog.text,
  p_settled_micro_usd pg_catalog.int8
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.gateway_attempts%rowtype;
begin
  if p_settled_micro_usd is null or p_settled_micro_usd < 0 then
    raise exception using errcode = '22023',
      message = 'gateway settlement amount must be a nonnegative micro-USD integer';
  end if;
  -- Callers settle the attempt row (same transaction) before invoking the
  -- seam, so the row carries the terminal usage this function classifies.
  select attempts.* into v_attempt
    from public.gateway_attempts attempts
   where attempts.attempt_id = p_attempt_id;
  if v_attempt.attempt_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway settlement attempt does not exist';
  end if;
  if p_settled_micro_usd = 0 then
    -- Nothing to debit: zero-completion insurance, a crash release, or an
    -- unknown-cost attempt. Only the last is a review case — work was
    -- delivered (output tokens) with no computable cost, billed $0 because
    -- "no markup" forbids billing a guess. Failed and crashed attempts are
    -- insurance, not review.
    if v_attempt.state in ('completed', 'incomplete', 'cancelled')
       and coalesce(v_attempt.output_tokens, 0) > 0
       and v_attempt.estimated_cost_micro_usd is null then
      update public.organizations
         set gateway_unknown_cost_attempts = gateway_unknown_cost_attempts + 1
       where id = p_org_id;
      if not found then
        raise exception using errcode = 'P0002',
          message = 'gateway settlement organization does not exist';
      end if;
    end if;
    return;
  end if;
  -- Draw the settled amount down from platform credits. billable_spend_usd
  -- ONLY, ratifying the runtime migration's call: recompute_org_spend cannot
  -- see gateway rows, so bumping spend_usd would be erased by the next
  -- repair, while billable_spend_usd is never recomputed (repairs go through
  -- auditable admin adjustments) and the Overview reads gateway_usage_daily.
  update public.organizations
     set billable_spend_usd =
       billable_spend_usd + (p_settled_micro_usd::pg_catalog.numeric / 1000000)
   where id = p_org_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'gateway settlement organization does not exist';
  end if;
end;
$$;
