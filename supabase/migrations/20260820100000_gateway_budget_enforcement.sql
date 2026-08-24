-- Gateway identity tier P-C: per-scope monthly BUDGETS made real at the
-- reservation seam.
--
-- P-A (20260820090000) shipped gateway_budgets as inert scope rows
-- (team/identity/pool/deployment, monthly micro-USD limit; absence of a row =
-- unlimited, which is today's behavior). This migration turns those rows into
-- an enforced, reserve-time, lock-serialized, reservation-aware gate, composed
-- ALONGSIDE billing's existing caps -- both must pass, neither rewrites the
-- other.
--
-- Placement mirrors the caps it sits next to. The only reserve-time money seam
-- is gateway_start_attempt (20260819190000), which for the host_managed lane
-- takes the organizations row lock and then, under that lock, sums outstanding
-- reservations and calls billing's gateway_spend_policy_check. Budgets are the
-- same shape of check: they read gateway_attempts for the current UTC month,
-- count dispatched attempts at their reservation and terminal attempts at their
-- settled amount (charged-or-reserved, identical to the pinned per-key cap), and
-- reject before the row is inserted. Sitting inside that same lock is what makes
-- two concurrent reservations unable to jointly exceed a budget.
--
-- Budgets are host_managed only, exactly like the caps: the org lock and the
-- reservation sums are only taken on that lane, and "BYOK traffic is never
-- counted" holds. A missing scope row is unlimited, so cutover (P-A seeded NO
-- budgets) enforces nothing -- the reservation path behaves exactly as before
-- until an operator sets a budget.
--
-- Operator contract (configuring and supporting budgets):
--   * A budget is a row in gateway_budgets: (org_id, period 'YYYY-MM',
--     scope_kind team|identity|pool|deployment, the scope's id columns, and
--     limit_micro_usd). Operators set/raise/remove them under Settings ->
--     Identities & access -> Budgets; the free-credit caps have their own admin
--     endpoint. There is no per-request override -- absence of a row = unlimited.
--   * Enforcement is worst-case at reserve time: a request is refused when its
--     maximum cost plus the scope's charged-or-reserved spend this UTC month
--     would exceed the limit. Refusals raise P1016/P1017/P1018/P1019
--     (team/identity/pool/deployment); the deployment scope advances the
--     waterfall to a sibling route, the coarser scopes stop routing.
--   * Unknown worst-case cost fails CLOSED: when a route's maximum cost is not
--     known (null), it cannot be bounded against a finite budget, so any
--     governing budget refuses it (rather than treating unknown as zero and
--     overshooting when the attempt settles). A route with no governing budget
--     still admits an unknown-cost call unchanged.

-- ---------------------------------------------------------------------------
-- 1. Scope spend: one scope's charged-or-reserved host_managed spend for a UTC
--    month window. Internal helper (no direct grants, like
--    gateway_attempt_cost_micro_usd); the reservation check below is its
--    consumer, and P-D's budgets read API can reuse it for balances.
--
--    Attempts carry pool_id/deployment_id directly but not identity or alias,
--    so identity scope resolves through the request's key
--    (gateway_requests -> api_keys.identity_id) and pool/deployment scope
--    resolve the alias through the request's frozen revision
--    (gateway_requests -> gateway_alias_revisions.alias_id). Denormalizing
--    identity_id/alias_id onto gateway_attempts is a later optimization
--    (flagged in the identity-tier plan Q5), not needed for launch volumes.

create function public.gateway_budget_scope_spent(
  p_org_id pg_catalog.uuid,
  p_scope_kind pg_catalog.text,
  p_identity_id pg_catalog.text,
  p_alias_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_deployment_id pg_catalog.text,
  p_month_start pg_catalog.timestamptz,
  p_next_month pg_catalog.timestamptz
)
returns pg_catalog.int8
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.sum(
    case when attempts.state = 'dispatched'
      then attempts.budget_reserved_micro_usd
      else coalesce(attempts.budget_settled_micro_usd, 0)
    end), 0)::pg_catalog.int8
  from public.gateway_attempts attempts
  where attempts.org_id = p_org_id
    and attempts.billing_source = 'host_managed'
    and attempts.budget_period_start >= p_month_start
    and attempts.budget_period_start < p_next_month
    and (
      p_scope_kind = 'team'
      or (p_scope_kind = 'identity' and exists (
            select 1
              from public.gateway_requests requests
              join public.api_keys keys on keys.id = requests.api_key_id
             where requests.request_id = attempts.request_id
               and keys.identity_id = p_identity_id))
      or (p_scope_kind in ('pool', 'deployment')
            and attempts.pool_id = p_pool_id
            and (p_scope_kind = 'pool'
                 or attempts.deployment_id = p_deployment_id)
            and exists (
              select 1
                from public.gateway_requests requests
                join public.gateway_alias_revisions revisions
                  on revisions.revision_id = requests.alias_revision_id
               where requests.request_id = attempts.request_id
                 and revisions.alias_id = p_alias_id))
    );
$$;

revoke all on function public.gateway_budget_scope_spent(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.timestamptz
) from public, anon, authenticated, service_role;

comment on function public.gateway_budget_scope_spent(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz, pg_catalog.timestamptz
) is
  'Charged-or-reserved host_managed spend (micro-USD) for one budget scope within a UTC month window: dispatched attempts count their reservation, terminal attempts their settled amount. Identity scope resolves through the request key, pool/deployment scope through the request''s frozen alias revision.';

-- ---------------------------------------------------------------------------
-- 2. The budget reservation check. For the request's own scope coordinates
--    (identity, alias, pool, deployment), find every budget row that governs
--    this dispatch for the current UTC month and reject on the first exceeded
--    one, tightest scope first, so the message names the most specific limit
--    the operator can act on. Same return shape as billing's
--    gateway_spend_policy_check (allowed / reason_code / message); the caller
--    maps reason_code onto a typed reservation SQLSTATE.
--
--    Reservation-aware and cap-aware in the same way the existing caps are: it
--    is only meaningful while the caller holds the organizations row lock, and
--    the proposed worst case is added to the already-counted outstanding
--    reservations. A worst case that fits exactly is admitted; the first
--    micro-dollar past the limit is refused (no budget overdraft).

create function public.gateway_budget_reservation_check(
  p_org_id pg_catalog.uuid,
  p_identity_id pg_catalog.text,
  p_alias_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_deployment_id pg_catalog.text,
  p_proposed_micro_usd pg_catalog.int8
)
returns table (
  allowed pg_catalog.bool,
  reason_code pg_catalog.text,
  message pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Nullable on purpose: a null proposed cost means the route's worst case is
  -- unknown, which cannot be bounded against a finite budget (handled below).
  v_proposed pg_catalog.int8 := p_proposed_micro_usd;
  v_utc_now pg_catalog.timestamp;
  v_month_floor pg_catalog.timestamp;
  v_period pg_catalog.text;
  v_month_start pg_catalog.timestamptz;
  v_next_month pg_catalog.timestamptz;
  v_budget public.gateway_budgets%rowtype;
  v_spent pg_catalog.int8;
  v_scope_label pg_catalog.text;
begin
  -- The month window is derived from UTC wall time so it is timezone-agnostic:
  -- date_trunc on the UTC-shifted timestamp gives the first of the month, and
  -- to_char formats the same value into the 'YYYY-MM' period key P-A stores.
  v_utc_now := pg_catalog.clock_timestamp() at time zone 'UTC';
  v_month_floor := pg_catalog.date_trunc('month', v_utc_now);
  v_period := pg_catalog.to_char(v_month_floor, 'YYYY-MM');
  v_month_start := v_month_floor at time zone 'UTC';
  v_next_month := (v_month_floor + pg_catalog.interval '1 month') at time zone 'UTC';

  for v_budget in
    select budgets.*
      from public.gateway_budgets budgets
     where budgets.org_id = p_org_id
       and budgets.period = v_period
       and (
         budgets.scope_kind = 'team'
         or (budgets.scope_kind = 'identity'
               and budgets.identity_id = p_identity_id)
         or (budgets.scope_kind = 'pool'
               and budgets.alias_id = p_alias_id
               and budgets.pool_id = p_pool_id)
         or (budgets.scope_kind = 'deployment'
               and budgets.alias_id = p_alias_id
               and budgets.pool_id = p_pool_id
               and budgets.deployment_id = p_deployment_id)
       )
     -- Tightest scope first: a dispatch capped at several levels reports the
     -- most specific budget the operator would raise.
     order by case budgets.scope_kind
       when 'deployment' then 0
       when 'pool' then 1
       when 'identity' then 2
       else 3
     end
  loop
    v_spent := public.gateway_budget_scope_spent(
      p_org_id, v_budget.scope_kind, v_budget.identity_id,
      v_budget.alias_id, v_budget.pool_id, v_budget.deployment_id,
      v_month_start, v_next_month
    );
    -- An unknown worst-case cost (v_proposed is null) cannot be bounded, so any
    -- governing budget rejects it. Tightest-scope-first ordering means a
    -- deployment budget still advances the waterfall to a sibling route while
    -- the coarser team/identity/pool scopes stop routing.
    if v_proposed is null or v_spent + v_proposed > v_budget.limit_micro_usd then
      v_scope_label := case v_budget.scope_kind
        when 'team' then 'organization'
        when 'identity' then 'identity ' || v_budget.identity_id
        when 'pool' then 'pool ' || v_budget.pool_id
        when 'deployment' then 'deployment ' || v_budget.deployment_id
      end;
      return query select
        false,
        ('budget_' || v_budget.scope_kind)::pg_catalog.text,
        ('budget_' || v_budget.scope_kind || ': this request''s worst case ('
         || case
              when v_proposed is null then 'unknown cost'
              else '$' || pg_catalog.to_char(
                v_proposed::pg_catalog.numeric / 1000000, 'FM999999990.00')
            end
         || ') would push the ' || v_scope_label || ' past its $'
         || pg_catalog.to_char(
              v_budget.limit_micro_usd::pg_catalog.numeric / 1000000,
              'FM999999990.00')
         || ' monthly budget for ' || v_period || ' (UTC; $'
         || pg_catalog.to_char(
              v_spent::pg_catalog.numeric / 1000000, 'FM999999990.00')
         || ' already reserved or settled this month, resets 00:00 UTC on the '
         || '1st). Raise or remove this budget in Settings -> Identities & '
         || 'access -> Budgets (' || public.gateway_webapp_url()
         || ').')::pg_catalog.text;
      return;
    end if;
  end loop;

  return query select true, null::pg_catalog.text, null::pg_catalog.text;
end;
$$;

revoke all on function public.gateway_budget_reservation_check(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated, service_role;

comment on function public.gateway_budget_reservation_check(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.int8
) is
  'Reserve-time per-scope monthly budget gate for one host_managed dispatch. Returns billing''s (allowed, reason_code, message) shape; reason_code is budget_{team,identity,pool,deployment}. Meaningful only under the organizations row lock (reservation-aware). Composed alongside gateway_spend_policy_check in gateway_start_attempt -- both must pass.';

-- ---------------------------------------------------------------------------
-- 3. Compose the budget gate into the reservation seam.
--
-- !!! SHARED FUNCTION BODY -- MERGE-TRAIN FLAG !!!
-- gateway_start_attempt's body is owned by the gateway runtime migration
-- (20260819190000) and is also a coordination point for the BILLING workstream
-- (billing-policy / billing-bc*), which owns the reserve-time money seams this
-- function calls. This packet CREATE OR REPLACEs it purely to insert ONE new
-- call (the budget gate below), reproducing the current body otherwise
-- unchanged. If billing also lands a gateway_start_attempt body, this is
-- LAST-WRITER-WINS on the whole body: whichever migration sorts later must fold
-- BOTH edits together. Do not resolve this by dropping either the budget block
-- or billing's cap block -- caps and budgets COMPOSE (both must pass). The
-- self-contained budget logic lives in gateway_budget_reservation_check above
-- precisely so re-merging is a one-line re-insertion, not a body rewrite.

create or replace function public.gateway_start_attempt(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_attempt_ordinal pg_catalog.int4,
  p_route_depth pg_catalog.int4,
  p_deployment_id pg_catalog.text,
  p_provider pg_catalog.text,
  p_exact_model_id pg_catalog.text,
  p_pool_id pg_catalog.text,
  p_catalog_sha256 pg_catalog.text,
  p_billing_source pg_catalog.text,
  p_pricing_source pg_catalog.text,
  p_pricing_effective_at pg_catalog.timestamptz,
  p_input_rate_micro_usd pg_catalog.int8,
  p_cached_input_rate_micro_usd pg_catalog.int8,
  p_output_rate_micro_usd pg_catalog.int8,
  p_reasoning_rate_micro_usd pg_catalog.int8,
  p_maximum_cost_micro_usd pg_catalog.int8
)
returns table (attempt_id pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.gateway_requests%rowtype;
  v_existing public.gateway_attempts%rowtype;
  v_attempt_id pg_catalog.text;
  v_period_start pg_catalog.timestamptz;
  v_limits public.gateway_key_limits%rowtype;
  v_rpm pg_catalog.int4;
  v_cap pg_catalog.int8;
  v_recent pg_catalog.int8;
  v_spent_today pg_catalog.int8;
  v_policy record;
  -- gw-identity P-C additions: the request's budget-scope coordinates and the
  -- budget gate's verdict.
  v_identity_id pg_catalog.text;
  v_alias_id pg_catalog.text;
  v_budget_policy record;
begin
  perform public.gateway_require_service_role();
  if p_billing_source not in ('customer_managed', 'host_managed') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt billing source';
  end if;
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id
   for update;
  if v_request.request_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway attempt request was not durably accepted';
  end if;
  if v_request.org_id <> p_org_id then
    raise exception using errcode = '23514',
      message = 'gateway attempt authority differs from the accepted request';
  end if;
  -- Replay receipt: a retried dispatch RPC (response lost after commit)
  -- returns the durable attempt id instead of a raw unique violation, and
  -- never re-reserves. Checked before the terminal/deadline gates so a late
  -- retry can still learn the id it needs to settle.
  select attempts.* into v_existing
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id
     and attempts.attempt_ordinal = p_attempt_ordinal;
  if v_existing.attempt_id is not null then
    if v_existing.org_id <> p_org_id
       or v_existing.deployment_id <> p_deployment_id
       or v_existing.billing_source <> p_billing_source then
      raise exception using errcode = '23505',
        message = 'gateway attempt ordinal is bound to a different dispatch';
    end if;
    return query select v_existing.attempt_id;
    return;
  end if;
  if v_request.terminal_state is not null then
    raise exception using errcode = '23514',
      message = 'gateway attempt request is already terminal';
  end if;
  if v_request.deadline_at <= pg_catalog.clock_timestamp() then
    -- Dispatching past the deadline would pay a provider for work the
    -- reconciler is already entitled to insure at zero.
    raise exception using errcode = '23514',
      message = 'gateway attempt request deadline has passed';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = v_request.api_key_id
      and keys.revoked_at is null
      and (keys.expires_at is null
        or keys.expires_at > pg_catalog.clock_timestamp())
  ) then
    -- Revocation bounds new provider streams: a key revoked between accept
    -- and dispatch must not keep spending on either lane.
    raise exception using errcode = '42501',
      message = 'gateway attempt api key is revoked or expired';
  end if;
  v_period_start := pg_catalog.date_trunc(
    'day', pg_catalog.clock_timestamp() at time zone 'UTC'
  ) at time zone 'UTC';

  if p_billing_source = 'host_managed' then
    -- Serialize all money decisions for the organization.
    perform 1 from public.organizations orgs
     where orgs.id = p_org_id
     for update;
    select limits.* into v_limits
      from public.gateway_key_limits limits
     where limits.api_key_id = v_request.api_key_id;
    if v_limits.api_key_id is not null then
      v_rpm := v_limits.requests_per_minute;
      v_cap := v_limits.daily_spend_cap_micro_usd;
    else
      v_rpm := 60;
      v_cap := case
        when public.gateway_org_free_credit_funded(p_org_id) then 50000000
        else null
      end;
    end if;
    if v_rpm is not null then
      -- Count HOST-LANE dispatches only, so "BYOK traffic is never rate
      -- limited" holds in behavior: pass-through acceptance and dispatch
      -- never move this counter.
      select pg_catalog.count(*) into v_recent
        from public.gateway_attempts attempts
        join public.gateway_requests requests
          on requests.request_id = attempts.request_id
       where requests.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.started_at
           >= pg_catalog.clock_timestamp() - pg_catalog.interval '60 seconds';
      if v_recent >= v_rpm then
        raise exception using errcode = 'P1012',
          message = pg_catalog.format(
            'key_rate_limit: this API key exceeded %s platform-funded '
            || 'dispatches per minute; slow down, or raise the key''s limit '
            || 'via the gateway key-limits API (BYOK dispatch is never '
            || 'counted or blocked)',
            v_rpm
          );
      end if;
    end if;
    if v_cap is not null and p_maximum_cost_micro_usd is null then
      -- Unknown worst-case price cannot be bounded under a hard cap: the
      -- ROUTE is ineligible (deployment scope; the waterfall advances).
      raise exception using errcode = 'P1013',
        message = 'deployment_price_unknown: this route has no known price and '
          || 'a daily spend cap applies, so it is ineligible; another route '
          || 'may serve the request';
    end if;
    if v_cap is not null then
      select coalesce(pg_catalog.sum(
          case when attempts.state = 'dispatched'
            then attempts.budget_reserved_micro_usd
            else coalesce(attempts.budget_settled_micro_usd, 0)
          end), 0)
        into v_spent_today
        from public.gateway_attempts attempts
        join public.gateway_requests requests
          on requests.request_id = attempts.request_id
       where requests.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.budget_period_start = v_period_start;
      if v_spent_today + p_maximum_cost_micro_usd > v_cap then
        raise exception using errcode = 'P1011',
          message = pg_catalog.format(
            'key_daily_cap: this request''s worst case (%s micro-USD) would '
            || 'push the key past its %s micro-USD daily cap (%s already '
            || 'reserved or settled today, UTC); retry after 00:00 UTC or '
            || 'raise the cap via the gateway key-limits API',
            p_maximum_cost_micro_usd, v_cap, v_spent_today
          );
      end if;
    end if;
    select policy.allowed, policy.reason_code, policy.message into v_policy
      from public.gateway_spend_policy_check(
        p_org_id, p_exact_model_id, coalesce(p_maximum_cost_micro_usd, 0)
      ) policy;
    if not v_policy.allowed then
      raise exception using
        errcode = case v_policy.reason_code
          when 'insufficient_credits' then 'P1010'
          when 'org_daily_cap' then 'P1014'
          when 'model_daily_cap' then 'P1015'
          else 'P1010'
        end,
        message = coalesce(
          v_policy.message,
          'insufficient_credits: the organization''s credit balance is exhausted'
        );
    end if;

    -- gw-identity P-C: per-scope monthly budgets, composed ALONGSIDE billing's
    -- caps above -- both must pass. Resolve the request's budget-scope
    -- coordinates (identity from the key, alias from the frozen revision; both
    -- may be null for a hard-deleted key/unknown revision, which simply cannot
    -- match an identity/pool/deployment budget) and reject if any governing
    -- budget row would be exceeded. Still under the organizations row lock, so
    -- the check stays reservation-aware exactly like the caps.
    select keys.identity_id into v_identity_id
      from public.api_keys keys
     where keys.id = v_request.api_key_id;
    select revisions.alias_id into v_alias_id
      from public.gateway_alias_revisions revisions
     where revisions.revision_id = v_request.alias_revision_id;
    select budget.allowed, budget.reason_code, budget.message
      into v_budget_policy
      from public.gateway_budget_reservation_check(
        p_org_id, v_identity_id, v_alias_id, p_pool_id, p_deployment_id,
        -- Pass the real (nullable) worst-case cost, NOT coalesced to zero: an
        -- unknown price must fail closed against a finite budget rather than
        -- reserve nothing and overshoot on settlement.
        p_maximum_cost_micro_usd
      ) budget;
    if not v_budget_policy.allowed then
      raise exception using
        errcode = case v_budget_policy.reason_code
          when 'budget_team' then 'P1016'
          when 'budget_identity' then 'P1017'
          when 'budget_pool' then 'P1018'
          when 'budget_deployment' then 'P1019'
          else 'P1016'
        end,
        message = v_budget_policy.message;
    end if;
  end if;

  v_attempt_id := 'attempt-'
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '');
  insert into public.gateway_attempts (
    attempt_id, request_id, org_id, attempt_ordinal, route_depth,
    deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
    billing_source, pricing_source, pricing_effective_at,
    input_rate_micro_usd, cached_input_rate_micro_usd,
    output_rate_micro_usd, reasoning_rate_micro_usd,
    state, started_at, budget_period_start, budget_reserved_micro_usd
  ) values (
    v_attempt_id, p_request_id, p_org_id, p_attempt_ordinal, p_route_depth,
    p_deployment_id, p_provider, p_exact_model_id, p_pool_id, p_catalog_sha256,
    p_billing_source, p_pricing_source, p_pricing_effective_at,
    p_input_rate_micro_usd, p_cached_input_rate_micro_usd,
    p_output_rate_micro_usd, p_reasoning_rate_micro_usd,
    'dispatched', pg_catalog.clock_timestamp(), v_period_start,
    coalesce(p_maximum_cost_micro_usd, 0)
  );
  return query select v_attempt_id;
end;
$$;

-- CREATE OR REPLACE preserves the runtime migration's grants on this signature
-- (revoked from public/anon/authenticated; executable by service_role).
