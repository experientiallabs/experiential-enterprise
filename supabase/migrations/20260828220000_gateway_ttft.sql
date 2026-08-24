-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Time-to-first-token (TTFT) on the per-request gateway log. The Experiential
-- runtime (>= 0.5.1, PR #594) stamps the winning attempt's first streamed
-- token and hands it to the platform's AttemptLedger seam
-- (explabs/gateway/ledger.py finish_attempt(first_token_at=...)), closing the
-- gap 20260828120000_gateway_insights_deep_telemetry.sql documented as "NOT
-- captured here, by design". Exactly the deep-telemetry pattern, three wires:
--
--   1. STORAGE.  gateway_attempts.first_token_at (timestamptz, NULL when the
--      attempt never produced a token: pre-dispatch failures, engines that do
--      not observe streaming, and every row settled before this deploy).
--      gateway_usage_events.ttft_ms carries the derived per-request value
--      (winning attempt first_token_at - started_at, ms) for the tenant read
--      layer, exactly like generation_duration_ms/routing_overhead_ms.
--
--   2. WRITE WIRE.  gateway_settle_attempt gains a trailing
--      p_first_token_at timestamptz default null (RETURNS void is unchanged
--      but the argument list grows, so drop + re-create, the same move
--      20260821110000 and 20260821200000 made); body is verbatim from the
--      coalesce-corrected settle in
--      20260828210000_fix_pg_catalog_coalesce_promo_functions.sql apart from
--      stamping first_token_at in both settlement branches. This migration
--      is numbered AFTER 20260828210000 on purpose: both re-create
--      gateway_settle_attempt, and last-redefinition-wins must land on the
--      TTFT-carrying body.
--      gateway_finalize_usage is re-created in place (same signature,
--      last-redefinition-wins) to read the winning attempt's first_token_at
--      and stamp ttft_ms onto the usage event.
--
--   3. READ WIRE.  list_gateway_usage_events gains a trailing ttft_ms column
--      (RETURNS TABLE changes, so drop + re-create with re-issued grants).
--
-- TTFT measures dispatch -> first token on the WINNING attempt only; it is
-- NULL (never zero) when no token was observed, so averages cannot be dragged
-- down by non-streaming or failed rows. Migration prefix 20260828220000 is
-- later than every existing migration.

-- ---------------------------------------------------------------------------
-- 1. STORAGE.

alter table public.gateway_attempts
  add column first_token_at pg_catalog.timestamptz;

comment on column public.gateway_attempts.first_token_at is
  'Wall-clock time this attempt streamed its first token, reported by the Experiential runtime at settlement. NULL when the attempt never produced a token (pre-dispatch failure, no streaming observation, or settled before TTFT capture shipped).';

alter table public.gateway_usage_events
  add column ttft_ms pg_catalog.int4
    check (ttft_ms is null or ttft_ms >= 0);

comment on column public.gateway_usage_events.ttft_ms is
  'Winning attempt started_at -> first_token_at, milliseconds (time to first token). NULL when no first token was observed. Written by gateway_finalize_usage.';

-- ---------------------------------------------------------------------------
-- 2a. WRITE WIRE: settle. Trailing defaulted parameter changes the argument
--     list, so drop the 11-parameter signature and re-create with 12; an
--     11-argument call from a not-yet-redeployed worker still resolves (the
--     new parameter defaults to null, and the old overload is gone).

drop function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text[], pg_catalog.text
);

create function public.gateway_settle_attempt(
  p_attempt_id pg_catalog.text,
  p_state pg_catalog.text,
  p_failure_class pg_catalog.text,
  p_input_tokens pg_catalog.int4,
  p_cached_input_tokens pg_catalog.int4,
  p_output_tokens pg_catalog.int4,
  p_reasoning_tokens pg_catalog.int4,
  p_usage_source pg_catalog.text,
  p_finalize_request pg_catalog.bool,
  p_tool_names pg_catalog.text[] default null,
  p_error_message pg_catalog.text default null,
  p_first_token_at pg_catalog.timestamptz default null
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
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
    -- COALESCE stays unqualified: it is Postgres grammar, not a pg_catalog
    -- function (the 20260828210000 correction this body is copied from).
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
           first_token_at = p_first_token_at,
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
           first_token_at = p_first_token_at,
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
$$;

revoke all on function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text[], pg_catalog.text, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text[], pg_catalog.text, pg_catalog.timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- 2b. WRITE WIRE: finalize. Same signature, so CREATE OR REPLACE (grants are
--     preserved). Body is verbatim from
--     20260828120000_gateway_insights_deep_telemetry.sql apart from the
--     winning attempt's first_token_at and the derived ttft_ms on the insert.

create or replace function public.gateway_finalize_usage(p_request_id pg_catalog.text)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.gateway_requests%rowtype;
  v_winning record;
  v_attempt_count pg_catalog.int4;
  v_cost pg_catalog.int8;
  v_estimated pg_catalog.int8;
  v_user pg_catalog.uuid;
  v_inserted pg_catalog.bool;
  v_first_dispatch_at pg_catalog.timestamptz;
  v_generation_ms pg_catalog.int4;
  v_routing_ms pg_catalog.int4;
  v_ttft_ms pg_catalog.int4;
begin
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id;
  if v_request.request_id is null or v_request.terminal_state is null then
    raise exception using errcode = '23514',
      message = 'gateway usage finalization requires a terminal request';
  end if;
  select attempts.provider, attempts.billing_source,
         coalesce(attempts.input_tokens, 0) as input_tokens,
         coalesce(attempts.output_tokens, 0) as output_tokens,
         coalesce(attempts.cached_input_tokens, 0) as cached_input_tokens,
         coalesce(attempts.reasoning_tokens, 0) as reasoning_tokens,
         attempts.tool_names,
         attempts.failure_class,
         attempts.error_message,
         attempts.started_at as started_at,
         attempts.terminal_at as terminal_at,
         attempts.first_token_at as first_token_at,
         -- A route is PRICED when its frozen base rates are present. This is the
         -- pricing_known signal, NOT the computed cost: cost is null whenever no
         -- usage was observed (every failed/cancelled call), which must not read
         -- as "unpriced". Host-lane dispatch fail-closes on an unknown price, so
         -- a null base rate here is a genuinely unpriced BYOK route.
         (attempts.input_rate_micro_usd is not null
          and attempts.output_rate_micro_usd is not null) as pricing_known,
         (attempts.attempt_id is not null) as dispatched
    into v_winning
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id
   order by attempts.attempt_ordinal desc
   limit 1;
  select pg_catalog.count(*)::pg_catalog.int4,
         coalesce(pg_catalog.sum(
           case attempts.billing_source
             when 'host_managed' then coalesce(attempts.budget_settled_micro_usd, 0)
             else 0
           end), 0),
         coalesce(pg_catalog.sum(
           case attempts.billing_source
             when 'customer_managed' then coalesce(
               attempts.estimated_cost_micro_usd,
               attempts.budget_settled_micro_usd, 0)
             else 0
           end), 0),
         pg_catalog.min(attempts.started_at)
    into v_attempt_count, v_cost, v_estimated, v_first_dispatch_at
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id;
  select keys.created_by into v_user
    from public.api_keys keys
   where keys.id = v_request.api_key_id;

  -- Generation duration: the winning attempt's dispatch-to-terminal span. NULL
  -- when nothing was dispatched or the winning attempt never terminalized.
  -- Clamped to int4 milliseconds, the same overflow guard the latency term uses.
  v_generation_ms := case
    when v_winning.started_at is null or v_winning.terminal_at is null then null
    else greatest(
      0::pg_catalog.int8,
      least(
        (extract(epoch from (v_winning.terminal_at - v_winning.started_at))
          * 1000)::pg_catalog.int8,
        2147483647::pg_catalog.int8
      )
    )::pg_catalog.int4
  end;
  -- Routing overhead: acceptance to the first upstream dispatch. NULL when no
  -- attempt was ever dispatched (nothing to precede).
  v_routing_ms := case
    when v_first_dispatch_at is null then null
    else greatest(
      0::pg_catalog.int8,
      least(
        (extract(epoch from (v_first_dispatch_at - v_request.accepted_at))
          * 1000)::pg_catalog.int8,
        2147483647::pg_catalog.int8
      )
    )::pg_catalog.int4
  end;
  -- Time to first token: the winning attempt's dispatch-to-first-token span.
  -- NULL (never zero) when no first token was observed, so non-streaming and
  -- pre-capture rows never drag an average toward zero. Same int4 clamp.
  v_ttft_ms := case
    when v_winning.started_at is null or v_winning.first_token_at is null then null
    else greatest(
      0::pg_catalog.int8,
      least(
        (extract(epoch from (v_winning.first_token_at - v_winning.started_at))
          * 1000)::pg_catalog.int8,
        2147483647::pg_catalog.int8
      )
    )::pg_catalog.int4
  end;

  insert into public.gateway_usage_events (
    request_id, org_id, api_key_id, user_id, alias, provider, lane,
    input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
    cost_micro_usd, estimated_cost_micro_usd, pricing_known,
    latency_ms, status, attempt_count, day, tools_used,
    failure_class, error_message,
    generation_duration_ms, routing_overhead_ms, ttft_ms
  ) values (
    p_request_id, v_request.org_id, v_request.api_key_id, v_user,
    v_request.alias, v_winning.provider,
    case v_winning.billing_source
      when 'host_managed' then 'platform_funded'
      when 'customer_managed' then 'pass_through'
      else null
    end,
    coalesce(v_winning.input_tokens, 0), coalesce(v_winning.output_tokens, 0),
    coalesce(v_winning.cached_input_tokens, 0),
    coalesce(v_winning.reasoning_tokens, 0),
    v_cost, v_estimated,
    -- A dispatched attempt is priced when its frozen base rates are known; a
    -- pre-dispatch terminal (no attempt) had no spend, so it is not "unpriced".
    case when coalesce(v_winning.dispatched, false)
      then coalesce(v_winning.pricing_known, false) else true end,
    -- Clamped: a caller-supplied deadline more than ~24.8 days out would
    -- otherwise overflow int4 here and wedge every reconcile pass.
    greatest(
      0::pg_catalog.int8,
      least(
        (extract(epoch from (v_request.terminal_at - v_request.accepted_at))
          * 1000)::pg_catalog.int8,
        2147483647::pg_catalog.int8
      )
    )::pg_catalog.int4,
    v_request.terminal_state, coalesce(v_attempt_count, 0),
    (v_request.terminal_at at time zone 'UTC')::pg_catalog.date,
    -- Tool names ride the winning attempt exactly like its token counts; NULL
    -- until the runtime surfaces them. Never stored as an empty array.
    case
      when v_winning.tool_names is null then null
      when pg_catalog.cardinality(v_winning.tool_names) = 0 then null
      else v_winning.tool_names
    end,
    -- Outcome reason: the winning attempt's, else the pre-dispatch request's.
    -- A completed/incomplete request has neither.
    coalesce(v_winning.failure_class, v_request.terminal_failure_class),
    coalesce(v_winning.error_message, v_request.terminal_error_message),
    v_generation_ms, v_routing_ms, v_ttft_ms
  )
  on conflict on constraint gateway_usage_events_pkey do nothing
  returning true into v_inserted;
  if v_inserted then
    insert into public.gateway_usage_daily as daily (
      org_id, user_id, day, alias,
      requests, input_tokens, output_tokens, spend_micro_usd
    ) values (
      v_request.org_id,
      coalesce(v_user, '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid),
      (v_request.terminal_at at time zone 'UTC')::pg_catalog.date,
      v_request.alias,
      1, coalesce(v_winning.input_tokens, 0),
      coalesce(v_winning.output_tokens, 0), v_cost + v_estimated
    )
    on conflict on constraint gateway_usage_daily_pkey do update
      set requests = daily.requests + 1,
          input_tokens = daily.input_tokens + excluded.input_tokens,
          output_tokens = daily.output_tokens + excluded.output_tokens,
          spend_micro_usd = daily.spend_micro_usd + excluded.spend_micro_usd,
          updated_at = pg_catalog.clock_timestamp();
  end if;
end;
$$;

revoke all on function public.gateway_finalize_usage(pg_catalog.text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. READ WIRE. Surface ttft_ms through the tenant per-request log. RETURNS
--    TABLE gains a trailing column, so drop and re-create (a return shape
--    cannot change via CREATE OR REPLACE). Body unchanged from
--    20260821200000_gateway_usage_metadata_errors.sql apart from the new
--    projection.

drop function public.list_gateway_usage_events(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
);

create function public.list_gateway_usage_events(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_alias pg_catalog.text default null,
  in_api_key_id pg_catalog.uuid default null,
  in_lane pg_catalog.text default null,
  in_status pg_catalog.text default null,
  in_cursor_ts pg_catalog.timestamptz default null,
  in_cursor_id pg_catalog.text default null,
  in_limit pg_catalog.int4 default 50
)
returns table (
  request_id pg_catalog.text,
  api_key_id pg_catalog.uuid,
  key_label pg_catalog.text,
  alias pg_catalog.text,
  provider pg_catalog.text,
  lane pg_catalog.text,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cached_input_tokens pg_catalog.int8,
  reasoning_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
  pricing_known pg_catalog.bool,
  latency_ms pg_catalog.int4,
  status pg_catalog.text,
  attempt_count pg_catalog.int4,
  created_at pg_catalog.timestamptz,
  tools_used pg_catalog.text[],
  failure_class pg_catalog.text,
  error_message pg_catalog.text,
  ttft_ms pg_catalog.int4
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  if in_lane is not null
     and in_lane not in ('pass_through', 'platform_funded') then
    raise exception using errcode = '22023',
      message = 'invalid gateway usage lane filter';
  end if;
  -- 'error' is the one aggregate shorthand: every terminal state that is not
  -- 'completed', matching the timeseries' error_count.
  if in_status is not null and in_status not in (
    'completed', 'failed', 'cancelled', 'incomplete',
    'expired_before_dispatch', 'unknown_after_crash', 'error'
  ) then
    raise exception using errcode = '22023',
      message = 'invalid gateway usage status filter';
  end if;
  return query
  select
    events.request_id,
    events.api_key_id,
    keys.name as key_label,
    events.alias,
    events.provider,
    events.lane,
    events.input_tokens,
    events.output_tokens,
    events.cached_input_tokens,
    events.reasoning_tokens,
    events.cost_micro_usd,
    events.estimated_cost_micro_usd,
    events.pricing_known,
    events.latency_ms,
    events.status,
    events.attempt_count,
    events.created_at,
    events.tools_used,
    events.failure_class,
    events.error_message,
    events.ttft_ms
  from public.gateway_usage_events events
  left join public.api_keys keys on keys.id = events.api_key_id
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
    and (in_before is null or events.created_at < in_before)
    and (in_alias is null or events.alias = in_alias)
    and (in_api_key_id is null or events.api_key_id = in_api_key_id)
    and (in_lane is null or events.lane = in_lane)
    and (
      in_status is null
      or (in_status = 'error' and events.status <> 'completed')
      or events.status = in_status
    )
    and (
      in_cursor_ts is null or in_cursor_id is null
      or (events.created_at, events.request_id) < (in_cursor_ts, in_cursor_id)
    )
  order by events.created_at desc, events.request_id desc
  limit cap;
end;
$$;

revoke all on function public.list_gateway_usage_events(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.list_gateway_usage_events(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
) to service_role;
