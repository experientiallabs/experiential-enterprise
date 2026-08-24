-- Re-issue the four gateway promo/spend functions from 20260828130000 and
-- 20260828140000 with bare COALESCE. Those migrations wrote
-- pg_catalog.coalesce(...), but COALESCE is Postgres grammar, not a callable
-- pg_catalog function, so every invocation raised
--   function pg_catalog.coalesce(bigint, integer) does not exist
-- at runtime: gateway_start_attempt calls gateway_pre_verify_allowance_micro_usd
-- on every attempt, so ALL platform-funded routes failed (502 all_routes_failed).
-- Bare COALESCE needs no schema qualification and is immune to the empty
-- search_path these SECURITY DEFINER functions run under. Bodies below are
-- otherwise identical to the originals (CREATE OR REPLACE preserves ACLs).
-- Already applied to prod directly on 2026-08-22; idempotent here.

CREATE OR REPLACE FUNCTION public.gateway_pre_verify_allowance_micro_usd()
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_allowance pg_catalog.int8;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'app_settings'
       and column_name = 'pre_verify_allowance_micro_usd'
  ) then
    execute 'select pre_verify_allowance_micro_usd from public.app_settings '
      || 'where singleton limit 1'
      into v_allowance;
  end if;
  return coalesce(v_allowance, 1000000);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.gateway_promo_state(p_org_id uuid, p_model_slug text, p_worst_case_micro_usd bigint)
 RETURNS TABLE(is_promo boolean, cap_micro_usd bigint, promo_spent_micro_usd bigint, within_cap boolean, cap_scope text, period_key text, notified boolean, percent_off numeric, has_free_tier boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_promo public.model_promotions%rowtype;
  v_month_floor pg_catalog.timestamp;
  v_month_start pg_catalog.timestamptz;
  v_next_month pg_catalog.timestamptz;
  v_period_key pg_catalog.text;
  v_spent pg_catalog.int8;
  v_notified pg_catalog.bool;
begin
  select promotions.* into v_promo
    from public.model_promotions promotions
   where promotions.slug = p_model_slug
     and promotions.active;
  -- Check the shared NOT NULL `slug` column (not `id`, which the catalog PR's
  -- table shape may not carry) to detect "no active promotion for this slug".
  if v_promo.slug is null then
    return query select
      false, null::pg_catalog.int8, 0::pg_catalog.int8, false,
      null::pg_catalog.text, null::pg_catalog.text, false,
      0::pg_catalog.numeric, false;
    return;
  end if;

  v_month_floor := pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'UTC'
  );
  v_month_start := v_month_floor at time zone 'UTC';
  v_next_month := (v_month_floor + pg_catalog.interval '1 month') at time zone 'UTC';
  v_period_key := case v_promo.cap_scope
    when 'recurring' then pg_catalog.to_char(v_month_floor, 'YYYY-MM')
    else 'lifetime'
  end;

  -- Charged-or-reserved promo spend for this (org, model): dispatched attempts
  -- at their promo reservation, terminal attempts at their settled promo cost.
  -- Recurring restricts to the current UTC month; lifetime spans all periods.
  select coalesce(pg_catalog.sum(
      case when attempts.state = 'dispatched'
        then attempts.promo_reserved_micro_usd
        else coalesce(attempts.promo_settled_micro_usd, 0)
      end), 0)
    into v_spent
    from public.gateway_attempts attempts
    join public.gateway_requests requests
      on requests.request_id = attempts.request_id
   where attempts.org_id = p_org_id
     and attempts.promo_funded
     and requests.alias = p_model_slug
     and (
       v_promo.cap_scope <> 'recurring'
       or (attempts.budget_period_start >= v_month_start
           and attempts.budget_period_start < v_next_month)
     );

  select exists (
    select 1 from public.model_promotion_notices notices
     where notices.org_id = p_org_id
       and notices.model_slug = p_model_slug
       and notices.period_key = v_period_key
  ) into v_notified;

  return query select
    true,
    v_promo.per_org_cap_micro_usd,
    v_spent,
    -- A null worst case (unknown price) cannot be bounded against the cap: not
    -- within it. host_managed callers never reach here with a null worst case
    -- (P1013 fires first), but keep the helper honest for any caller.
    p_worst_case_micro_usd is not null
      and v_spent + p_worst_case_micro_usd <= v_promo.per_org_cap_micro_usd,
    v_promo.cap_scope,
    v_period_key,
    v_notified,
    v_promo.percent_off,
    v_promo.per_org_cap_micro_usd > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.gateway_settle_attempt(p_attempt_id text, p_state text, p_failure_class text, p_input_tokens integer, p_cached_input_tokens integer, p_output_tokens integer, p_reasoning_tokens integer, p_usage_source text, p_finalize_request boolean, p_tool_names text[] DEFAULT NULL::text[], p_error_message text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_attempt public.gateway_attempts%rowtype;
  v_cost pg_catalog.int8;
  v_settled pg_catalog.int8;
begin
  perform public.gateway_require_service_role();
  if p_state not in ('completed', 'failed', 'cancelled', 'incomplete') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt terminal state';
  end if;
  if p_usage_source is null
     or p_usage_source not in ('observed', 'estimated', 'unknown') then
    raise exception using errcode = '22023',
      message = 'invalid gateway attempt usage source';
  end if;
  if p_error_message is not null
     and pg_catalog.char_length(p_error_message) > 4096 then
    raise exception using errcode = '22023',
      message = 'gateway attempt error message exceeds 4096 characters';
  end if;
  select attempts.* into v_attempt
    from public.gateway_attempts attempts
   where attempts.attempt_id = p_attempt_id
   for update;
  if v_attempt.attempt_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway attempt does not exist';
  end if;
  if v_attempt.state <> 'dispatched' then
    if v_attempt.state = p_state then
      -- Replay receipt — but still honor a requested finalize a prior call
      -- skipped (settled finalize=false, then the waterfall ended): without
      -- this the request stays open forever, invisible to both settle and
      -- the reconciler, and its usage event is never emitted.
      if p_finalize_request then
        update public.gateway_requests
           set terminal_state = p_state,
               terminal_at = pg_catalog.clock_timestamp()
         where request_id = v_attempt.request_id
           and terminal_state is null;
        perform public.gateway_finalize_usage(v_attempt.request_id);
      end if;
      return;
    end if;
    raise exception using errcode = '23514',
      message = 'gateway attempt is already settled with another terminal state';
  end if;
  if p_finalize_request then
    -- Take the request lock before the organizations update so the lock
    -- order (request -> organizations) matches gateway_start_attempt;
    -- acquiring them in the opposite order here can deadlock with a
    -- concurrent dispatch of the same request.
    perform 1 from public.gateway_requests requests
     where requests.request_id = v_attempt.request_id
     for update;
  end if;
  v_cost := public.gateway_attempt_cost_micro_usd(
    p_input_tokens, p_cached_input_tokens, p_output_tokens, p_reasoning_tokens,
    v_attempt.input_rate_micro_usd, v_attempt.cached_input_rate_micro_usd,
    v_attempt.output_rate_micro_usd, v_attempt.reasoning_rate_micro_usd
  );
  if v_attempt.billing_source = 'host_managed' then
    v_settled := case
      when p_state = 'failed' or coalesce(p_output_tokens, 0) = 0 then 0
      else coalesce(v_cost, 0)
    end;
  else
    -- Never charged; the conservative attributed value mirrors WMO's ledger.
    v_settled := coalesce(v_cost, v_attempt.budget_reserved_micro_usd);
  end if;
  if v_attempt.promo_funded then
    -- Free promo spend (always host_managed): record the settled cost in the
    -- promo column and keep budget_settled 0, so no credit/budget/cap read ever
    -- charges it. gateway_settle_billing is NOT called: promo never debits
    -- org credits.
    update public.gateway_attempts
       set state = p_state,
           terminal_at = pg_catalog.clock_timestamp(),
           failure_class = p_failure_class,
           input_tokens = p_input_tokens,
           cached_input_tokens = p_cached_input_tokens,
           output_tokens = p_output_tokens,
           reasoning_tokens = p_reasoning_tokens,
           usage_source = p_usage_source,
           estimated_cost_micro_usd = v_cost,
           budget_settled_micro_usd = 0,
           promo_settled_micro_usd = v_settled,
           tool_names = case
             when p_tool_names is null then null
             when pg_catalog.cardinality(p_tool_names) = 0 then null
             else p_tool_names
           end,
           error_message = p_error_message
     where attempt_id = p_attempt_id;
  else
    -- Credit-funded: apply this attempt's frozen promo discount (0 for non-promo
    -- and BYOK) to the CHARGE. estimated_cost_micro_usd keeps the full cost;
    -- budget_settled and the credit debit use the discounted amount, matching the
    -- discounted reservation taken at dispatch.
    v_settled := pg_catalog.round(
      v_settled::pg_catalog.numeric * (100 - v_attempt.promo_discount_percent) / 100
    )::pg_catalog.int8;
    update public.gateway_attempts
       set state = p_state,
           terminal_at = pg_catalog.clock_timestamp(),
           failure_class = p_failure_class,
           input_tokens = p_input_tokens,
           cached_input_tokens = p_cached_input_tokens,
           output_tokens = p_output_tokens,
           reasoning_tokens = p_reasoning_tokens,
           usage_source = p_usage_source,
           estimated_cost_micro_usd = v_cost,
           budget_settled_micro_usd = v_settled,
           -- Names only, never arguments. Empty collapses to NULL so the usage
           -- event's "not captured" and "called no tools" read the same.
           tool_names = case
             when p_tool_names is null then null
             when pg_catalog.cardinality(p_tool_names) = 0 then null
             else p_tool_names
           end,
           -- Sanitized reason, content-free; null on success.
           error_message = p_error_message
     where attempt_id = p_attempt_id;
    if v_attempt.billing_source = 'host_managed' then
      perform public.gateway_settle_billing(
        v_attempt.org_id, v_attempt.request_id, p_attempt_id, v_settled
      );
    end if;
  end if;
  if p_finalize_request then
    update public.gateway_requests
       set terminal_state = p_state,
           terminal_at = pg_catalog.clock_timestamp()
     where request_id = v_attempt.request_id
       and terminal_state is null;
    perform public.gateway_finalize_usage(v_attempt.request_id);
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.gateway_start_attempt(p_request_id text, p_org_id uuid, p_attempt_ordinal integer, p_route_depth integer, p_deployment_id text, p_provider text, p_exact_model_id text, p_pool_id text, p_catalog_sha256 text, p_billing_source text, p_pricing_source text, p_pricing_effective_at timestamp with time zone, p_input_rate_micro_usd bigint, p_cached_input_rate_micro_usd bigint, p_output_rate_micro_usd bigint, p_reasoning_rate_micro_usd bigint, p_maximum_cost_micro_usd bigint)
 RETURNS TABLE(attempt_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request public.gateway_requests%rowtype;
  v_existing public.gateway_attempts%rowtype;
  v_attempt_id pg_catalog.text;
  v_period_start pg_catalog.timestamptz;
  v_limits public.gateway_key_limits%rowtype;
  v_rpm pg_catalog.int4;
  v_tpm pg_catalog.int4;
  v_cap pg_catalog.int8;
  v_recent pg_catalog.int8;
  v_recent_tokens pg_catalog.int8;
  v_spent_today pg_catalog.int8;
  v_policy record;
  -- gw-identity P-C additions: the request's budget-scope coordinates and the
  -- budget gate's verdict.
  v_identity_id pg_catalog.text;
  v_alias_id pg_catalog.text;
  v_budget_policy record;
  -- Promotional-model funding state and the resolved funding lane for this
  -- attempt ('promo' = free, does not draw credits; 'credits' = normal gates).
  v_promo record;
  v_funding pg_catalog.text := 'credits';
  -- Promo percent discount for a credit-funded promo attempt (0 otherwise) and
  -- the worst-case amount the credit gates and the reservation actually charge,
  -- net of that discount. Defaults to the full worst case (non-promo / BYOK).
  v_percent_off pg_catalog.numeric := 0;
  v_charge_worst pg_catalog.int8 := coalesce(p_maximum_cost_micro_usd, 0);
  -- Pre-verify allowance.
  v_allowance pg_catalog.int8;
  v_pre_verify_spent pg_catalog.int8;
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
      v_tpm := v_limits.tokens_per_minute;
      v_cap := v_limits.daily_spend_cap_micro_usd;
    else
      v_rpm := 60;
      v_tpm := null;
      v_cap := case
        when public.gateway_org_free_credit_funded(p_org_id) then 50000000
        else null
      end;
    end if;
    -- RPM/TPM/price-unknown apply to EVERY host-lane dispatch (abuse and
    -- fail-closed guards), independent of whether the request is promo-funded
    -- or credit-funded; they run before the funding split.
    if v_rpm is not null then
      -- Count HOST-LANE dispatches only, so "BYOK traffic is never rate
      -- limited" holds in behavior: pass-through acceptance and dispatch
      -- never move this counter. Reads the attempt's own denormalized key so
      -- the scan is bounded by the 60s window (gateway_attempts_key_started_idx),
      -- not the key's lifetime request count.
      select pg_catalog.count(*) into v_recent
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
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
    if v_tpm is not null then
      -- TPM is trailing observation: token counts exist only after an attempt
      -- settles, so sum the settled tokens of attempts that went terminal in
      -- the last 60s and refuse the NEXT dispatch once the limit is met. A
      -- single large stream may overshoot; the key then waits out the window.
      -- Host lane only, like every money gate here.
      select coalesce(pg_catalog.sum(
          coalesce(attempts.input_tokens, 0)
          + coalesce(attempts.cached_input_tokens, 0)
          + coalesce(attempts.output_tokens, 0)
          + coalesce(attempts.reasoning_tokens, 0)), 0)
        into v_recent_tokens
        from public.gateway_attempts attempts
       where attempts.api_key_id = v_request.api_key_id
         and attempts.billing_source = 'host_managed'
         and attempts.terminal_at is not null
         and attempts.terminal_at
           >= pg_catalog.clock_timestamp() - pg_catalog.interval '60 seconds';
      if v_recent_tokens >= v_tpm then
        raise exception using errcode = 'P1022',
          message = pg_catalog.format(
            'key_token_rate_limit: this API key''s platform-funded traffic '
            || 'settled %s tokens in the last 60 seconds, at or past its %s '
            || 'tokens-per-minute limit; wait for the window to drain, or '
            || 'raise the key''s limit via the gateway key-limits API (BYOK '
            || 'dispatch is never counted or blocked)',
            v_recent_tokens, v_tpm
          );
      end if;
    end if;
    if p_maximum_cost_micro_usd is null then
      -- An unknown worst-case price cannot be bounded against a daily spend
      -- cap, the org credit balance, a per-scope budget, OR the promo cap:
      -- reserving it as $0 (the historical coalesce below) slipped every one of
      -- those gates and let settlement drive the account negative. The ROUTE is
      -- ineligible (deployment scope; the waterfall advances to a known-price
      -- route, or the request fails if none is priced). Fires regardless of
      -- whether a daily cap applies, and BEFORE the balance/budget/promo checks
      -- below, so no unknown price ever reaches them. BYOK is unaffected.
      raise exception using errcode = 'P1013',
        message = 'deployment_price_unknown: this route has no known price, so '
          || 'its spend cannot be bounded against the credit balance, a daily '
          || 'cap, or a scope budget; it is ineligible and another route may '
          || 'serve the request';
    end if;

    -- Promo funding split. A request for an active promotional model whose org
    -- is still under the cap (and has not yet been notified of exhaustion) is
    -- promo-funded (FREE): it skips the credit gates entirely. Everything else
    -- -- a non-promo model, or a promo model whose cap is reached -- takes the
    -- credits path below. Monotonic: once the exhaustion notice is delivered
    -- for this (org, model, period), later requests draw credits even if a
    -- sliver of promo would still fit.
    select promo.is_promo, promo.within_cap, promo.notified,
           promo.cap_micro_usd, promo.promo_spent_micro_usd,
           promo.percent_off, promo.has_free_tier
      into v_promo
      from public.gateway_promo_state(
        p_org_id, v_request.alias, p_maximum_cost_micro_usd
      ) promo;
    -- Free (promo-funded) only when a free tier exists and this org is still
    -- under it and has not been notified of exhaustion. A pure-discount promo
    -- (no free tier) or an exhausted/notified free tier takes the credits path,
    -- where percent_off discounts the charge.
    if v_promo.is_promo and v_promo.has_free_tier
       and v_promo.within_cap and not v_promo.notified then
      v_funding := 'promo';
    else
      v_funding := 'credits';
    end if;
    -- Resolve the credit-charge worst case for this attempt. A credit-funded
    -- promo with percent_off > 0 charges (1 - percent_off/100) of the full worst
    -- case; every credit/budget/cap gate below and the reservation use this
    -- discounted figure so the reservation and the eventual settled charge agree.
    v_percent_off := case when v_promo.is_promo then coalesce(v_promo.percent_off, 0) else 0 end;
    if v_funding = 'credits' and v_percent_off > 0 then
      v_charge_worst := pg_catalog.round(
        coalesce(p_maximum_cost_micro_usd, 0)::pg_catalog.numeric
        * (100 - v_percent_off) / 100
      )::pg_catalog.int8;
    else
      v_charge_worst := coalesce(p_maximum_cost_micro_usd, 0);
    end if;

    if v_funding = 'credits' then
      -- Promo exhaustion transition (3a/3c). A promo model on the credits path
      -- is here because the cap is reached. If the org has NOT been notified,
      -- this is the visible switch: refuse once with P1030 (the ledger commits
      -- the one-time notice marker out of band, so the retry falls through to
      -- the credit gates). If already notified, fall through; a later
      -- insufficient_credits below becomes P1031 (BYOK-only) for a promo model.
      -- Only fire the free->credits switch notice when a free tier actually
      -- existed and is now exhausted (has_free_tier). A pure-discount promo
      -- (cap 0) has no free phase, so it never announces one; it just applies
      -- the discount on the credits path below.
      if v_promo.is_promo and v_promo.has_free_tier and not v_promo.notified then
        raise exception using errcode = 'P1030',
          message = pg_catalog.format(
            'promo_exhausted_notice: your free promo for %s is used up ($%s of '
            || '$%s). Further requests to this model now draw your '
            || 'organization''s platform credits%s -- retry to continue. '
            || 'Requests using your own provider keys (BYOK) are unaffected.',
            v_request.alias,
            pg_catalog.to_char(
              v_promo.promo_spent_micro_usd::pg_catalog.numeric / 1000000,
              'FM999999990.00'),
            pg_catalog.to_char(
              v_promo.cap_micro_usd::pg_catalog.numeric / 1000000,
              'FM999999990.00'),
            case when v_percent_off > 0
              then ' at ' || pg_catalog.to_char(v_percent_off, 'FM999999990.##') || '% off'
              else '' end
          );
      end if;

      -- Spend gate, decoupled from login, RELAXED to a cumulative allowance
      -- (money half of instant signup). An org whose founding admin exists but
      -- whose spend_unlocked_at is null may draw platform credits only up to
      -- app_settings.pre_verify_allowance_micro_usd (default $1) of cumulative
      -- charged-or-reserved spend, then P1025 blocks the rest until they verify;
      -- an allowance of 0 blocks all unverified credit spend (prior behavior).
      -- Promo-free spend never counts (promo attempts hold 0 in budget_*).
      -- Fires FIRST in the credit path, before any cap/budget check, and only
      -- when a present admin membership exists -- so a membership-less fixture
      -- org is never gated. BYOK skips this whole block.
      if exists (
        select 1
          from public.organization_members members
          join public.organizations orgs on orgs.id = members.org_id
         where members.org_id = p_org_id
           and members.role = 'admin'
           and orgs.spend_unlocked_at is null
      ) then
        v_allowance := public.gateway_pre_verify_allowance_micro_usd();
        select coalesce(pg_catalog.sum(
            case when attempts.state = 'dispatched'
              then attempts.budget_reserved_micro_usd
              else coalesce(attempts.budget_settled_micro_usd, 0)
            end), 0)
          into v_pre_verify_spent
          from public.gateway_attempts attempts
         where attempts.org_id = p_org_id
           and attempts.billing_source = 'host_managed';
        if v_pre_verify_spent + v_charge_worst > v_allowance then
          raise exception using errcode = 'P1025',
            message = case
              when v_allowance <= 0 then
                'org_owner_unverified: confirm your email to spend platform '
                || 'credits -- check your inbox for the verification link; '
                || 'everything else, including BYOK (your own provider keys) '
                || 'and trace uploads, works now'
              else
                'org_owner_unverified: your organization has used its $'
                || pg_catalog.to_char(
                     v_allowance::pg_catalog.numeric / 1000000,
                     'FM999999990.00')
                || ' pre-verification credit allowance ($'
                || pg_catalog.to_char(
                     v_pre_verify_spent::pg_catalog.numeric / 1000000,
                     'FM999999990.00')
                || ' used); confirm your email to spend the rest of your '
                || 'credits -- check your inbox for the verification link. '
                || 'BYOK (your own provider keys) and trace uploads are '
                || 'unaffected'
            end;
        end if;
      end if;

      if v_cap is not null then
        select coalesce(pg_catalog.sum(
            case when attempts.state = 'dispatched'
              then attempts.budget_reserved_micro_usd
              else coalesce(attempts.budget_settled_micro_usd, 0)
            end), 0)
          into v_spent_today
          from public.gateway_attempts attempts
         where attempts.api_key_id = v_request.api_key_id
           and attempts.billing_source = 'host_managed'
           and attempts.budget_period_start = v_period_start;
        if v_spent_today + v_charge_worst > v_cap then
          raise exception using errcode = 'P1011',
            message = pg_catalog.format(
              'key_daily_cap: this request''s worst case (%s micro-USD) would '
              || 'push the key past its %s micro-USD daily cap (%s already '
              || 'reserved or settled today, UTC); retry after 00:00 UTC or '
              || 'raise the cap via the gateway key-limits API',
              v_charge_worst, v_cap, v_spent_today
            );
        end if;
      end if;
      select policy.allowed, policy.reason_code, policy.message into v_policy
        from public.gateway_spend_policy_check(
          p_org_id, p_exact_model_id, v_charge_worst
        ) policy;
      if not v_policy.allowed then
        -- A promo model whose free allowance is spent AND whose org credits
        -- cannot cover it is BYOK-only for that org (3c): the platform stops
        -- serving it on the house lane. Surface P1031 so the terminal state is
        -- unambiguous; every other refusal keeps billing's own codes.
        if v_promo.is_promo and v_policy.reason_code = 'insufficient_credits' then
          raise exception using errcode = 'P1031',
            message = pg_catalog.format(
              'promo_byok_only: your free promo for %s is used up and your '
              || 'organization''s credits cannot cover it, so %s is now '
              || 'available only with your own provider keys (BYOK). Add '
              || 'credits at %s/credits to serve it on the platform again; '
              || 'BYOK requests are unaffected.',
              v_request.alias, v_request.alias, public.gateway_webapp_url()
            );
        end if;
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
          p_org_id, v_request.api_key_id, v_identity_id, v_alias_id, p_pool_id,
          p_deployment_id,
          -- The discounted worst case this attempt will actually charge credits.
          -- Non-null here (P1013 already rejected an unknown host price), so the
          -- budget gate bounds the real credit impact, promo discount included.
          v_charge_worst
        ) budget;
      if not v_budget_policy.allowed then
        raise exception using
          errcode = case v_budget_policy.reason_code
            when 'budget_team' then 'P1016'
            when 'budget_identity' then 'P1017'
            when 'budget_pool' then 'P1018'
            when 'budget_deployment' then 'P1019'
            when 'budget_key' then 'P1023'
            when 'budget_model' then 'P1024'
            else 'P1016'
          end,
          message = v_budget_policy.message;
      end if;
    end if;
  end if;

  v_attempt_id := 'attempt-'
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::pg_catalog.text, '-', '');
  insert into public.gateway_attempts (
    attempt_id, request_id, org_id, api_key_id, attempt_ordinal, route_depth,
    deployment_id, provider, exact_model_id, pool_id, catalog_sha256,
    billing_source, pricing_source, pricing_effective_at,
    input_rate_micro_usd, cached_input_rate_micro_usd,
    output_rate_micro_usd, reasoning_rate_micro_usd,
    state, started_at, budget_period_start, budget_reserved_micro_usd,
    promo_funded, promo_reserved_micro_usd, promo_discount_percent
  ) values (
    v_attempt_id, p_request_id, p_org_id, v_request.api_key_id,
    p_attempt_ordinal, p_route_depth,
    p_deployment_id, p_provider, p_exact_model_id, p_pool_id, p_catalog_sha256,
    p_billing_source, p_pricing_source, p_pricing_effective_at,
    p_input_rate_micro_usd, p_cached_input_rate_micro_usd,
    p_output_rate_micro_usd, p_reasoning_rate_micro_usd,
    'dispatched', pg_catalog.clock_timestamp(), v_period_start,
    -- Promo-funded attempts hold their FULL worst case in promo_reserved and 0
    -- in budget_reserved (no credit/budget/cap read counts them). Credit-funded
    -- attempts reserve the discounted worst case against credits.
    case when v_funding = 'promo' then 0 else v_charge_worst end,
    v_funding = 'promo',
    case when v_funding = 'promo'
         then coalesce(p_maximum_cost_micro_usd, 0) else 0 end,
    -- Freeze the discount for settlement; free promo attempts carry 0 (they are
    -- fully free via the promo columns, not a credit discount).
    case when v_funding = 'credits' then v_percent_off else 0 end
  );
  return query select v_attempt_id;
end;
$function$
;
