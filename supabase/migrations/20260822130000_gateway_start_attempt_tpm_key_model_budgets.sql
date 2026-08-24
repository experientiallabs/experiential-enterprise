-- ---------------------------------------------------------------------------
-- !!! SHARED FUNCTION BODY -- MERGE-TRAIN FLAG !!!
-- gateway_start_attempt is CREATE OR REPLACEd by several workstreams and the
-- LAST timestamp wins on a fresh migrate-all. This migration is the new LAST
-- redefinition and carries EVERY money guard. Anyone replacing this body later
-- must carry ALL of:
--   * RPM sliding window                      P1012 (host lane)
--   * TPM trailing settled-token window       P1022 (host lane, added here)
--   * price-unknown fail-closed               P1013 (unconditional, host lane)
--   * per-key daily spend cap                 P1011
--   * balance + free-credit caps              P1010 / P1014 / P1015
--   * per-scope monthly budgets               P1016-P1019, P1023 key,
--                                             P1024 model (added here)
-- pgTAP pins the COMPOSED function (budget enforcement + runtime suites);
-- explabs/gateway/e2e_test.py pins it end-to-end. Extend those when touching
-- this body.
--
-- Changes vs 20260821170000 (everything else is verbatim):
--   1. TPM gate (P1022 key_token_rate_limit): total settled tokens (input +
--      cached input + output + reasoning) across the key's host-lane attempts
--      with terminal_at in the trailing 60s. Trailing observation -- tokens
--      exist only after settlement, so the breaching request lands and the
--      NEXT dispatch is refused until the window drains. No default; only an
--      explicit gateway_key_limits.tokens_per_minute arms it.
--   2. The RPM and daily-cap scans read the denormalized
--      gateway_attempts.api_key_id (20260822110000) instead of joining
--      through gateway_requests, so each scan is bounded by its window via
--      the partial per-key indexes instead of the key's lifetime requests.
--      Same rows, same semantics: both columns null out together on key
--      deletion.
--   3. The budget gate passes the dispatching key to the widened
--      gateway_budget_reservation_check (20260822120000) and maps the new
--      budget_key -> P1023 and budget_model -> P1024 rejections. Both stop
--      routing (no sibling route escapes a key or model budget).
--   4. The attempt insert stamps api_key_id; the straggler backfill at the
--      bottom covers rows dispatched between 20260822110000 and this
--      migration by the not-yet-replaced function.
-- ---------------------------------------------------------------------------

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
      -- cap, the org credit balance, OR a per-scope budget: reserving it as $0
      -- (the historical coalesce below) slipped every one of those gates and
      -- let settlement drive the account negative. The ROUTE is ineligible
      -- (deployment scope; the waterfall advances to a known-price route, or
      -- the request fails if none is priced). Fires regardless of whether a
      -- daily cap applies, and BEFORE the balance/budget checks below, so no
      -- unknown price ever reaches them. BYOK is unaffected: host-lane only.
      raise exception using errcode = 'P1013',
        message = 'deployment_price_unknown: this route has no known price, so '
          || 'its spend cannot be bounded against the credit balance, a daily '
          || 'cap, or a scope budget; it is ineligible and another route may '
          || 'serve the request';
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
        p_org_id, v_request.api_key_id, v_identity_id, v_alias_id, p_pool_id,
        p_deployment_id,
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
          when 'budget_key' then 'P1023'
          when 'budget_model' then 'P1024'
          else 'P1016'
        end,
        message = v_budget_policy.message;
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
    state, started_at, budget_period_start, budget_reserved_micro_usd
  ) values (
    v_attempt_id, p_request_id, p_org_id, v_request.api_key_id,
    p_attempt_ordinal, p_route_depth,
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

-- Straggler backfill: any attempt dispatched between 20260822110000 and this
-- migration by the not-yet-replaced function body lacks api_key_id.
update public.gateway_attempts attempts
   set api_key_id = requests.api_key_id
  from public.gateway_requests requests
 where requests.request_id = attempts.request_id
   and attempts.api_key_id is null
   and requests.api_key_id is not null;
