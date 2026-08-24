-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Fine-grained per-call telemetry on the canonical usage stream: the maximum
-- non-content metadata a finished request can carry, and the reason a non-OK
-- request ended. Three telemetry gaps closed here, all content-free (the ledger
-- never persists request/response bodies; see 20260819190000_gateway_runtime.sql):
--
--   1. COST FIDELITY. The per-call cost is already computed and stored in
--      micro-USD (gateway_attempt_cost_micro_usd, frozen rates), but a request
--      whose winning attempt had an UNKNOWN price settles to 0 on both money
--      columns and then reads as a free "$0.00" call. Carry pricing_known onto
--      the event so the tenant surface can say "unpriced" instead of "$0.00" —
--      an unpriced route must never read as free (mirrors the money module's
--      house rule and gateway_attempt_cost_micro_usd's null-on-unknown contract).
--
--   2. MAX METADATA. cached_input_tokens and reasoning_tokens are observed per
--      attempt (gateway_settle_attempt writes them onto gateway_attempts) but
--      are dropped at the event boundary today. Carry them onto the event so the
--      full token breakdown — prompt / cached / completion / reasoning — is
--      tenant-visible, alongside the provider, lane, and attempt count already
--      surfaced.
--
--   3. OUTCOME REASON. A failed/cancelled request records a failure_class on its
--      attempt (or, pre-dispatch, on the request), and WMO's sanitized
--      GatewayFailure carries a human-readable safe_message. Neither reaches the
--      tenant, so a non-OK row shows a bare status with no "why". Carry both
--      failure_class and a sanitized error_message onto the event; a completed /
--      incomplete request has neither (the status IS the outcome — WMO exposes no
--      finer finish_reason than the terminal kind).
--
-- All additions are nullable or defaulted, so every existing settle/finish
-- caller stays valid; the finalize step copies the new fields from the winning
-- attempt exactly as it already copies input_tokens/output_tokens/tool_names.
-- gateway_finalize_usage / gateway_settle_attempt / gateway_finish_request are
-- re-created from their latest definitions (20260821110000_gateway_usage_tools.sql
-- for the first two; 20260819190000_gateway_runtime.sql for finish_request),
-- bodies otherwise unchanged apart from the new fields; list_gateway_usage_events
-- from 20260821120000_gateway_usage_tools_read.sql gains trailing columns.
--
-- Migration prefix 20260821200000 is collision-free across the assembled train
-- union (append-only; the only drops re-add a widened signature / return shape).

-- ---------------------------------------------------------------------------
-- 1. STORAGE. New content-free columns on the canonical event, the per-attempt
--    carrier the finalize step reads from the winning attempt, and the
--    request-level carrier for pre-dispatch failures (which have no attempt).

alter table public.gateway_usage_events
  add column cached_input_tokens pg_catalog.int8 not null default 0
    check (cached_input_tokens >= 0),
  add column reasoning_tokens pg_catalog.int8 not null default 0
    check (reasoning_tokens >= 0),
  -- False only when the winning attempt dispatched under an unknown (null)
  -- frozen price, so cost_micro_usd + estimated_cost_micro_usd is 0 not because
  -- the call was free but because it could not be priced. True for every priced
  -- request and for pre-dispatch failures (no provider spend occurred).
  add column pricing_known pg_catalog.bool not null default true,
  -- The winning attempt's WMO failure class (or the pre-dispatch request's),
  -- null for a completed/incomplete request. Structured outcome category.
  add column failure_class pg_catalog.text,
  -- WMO's sanitized human-readable failure reason (GatewayFailure.safe_message),
  -- null for a completed/incomplete request. Content-free by WMO's contract.
  add column error_message pg_catalog.text
    check (error_message is null or pg_catalog.char_length(error_message) <= 4096);

comment on column public.gateway_usage_events.cached_input_tokens is
  'Winning attempt''s cached prompt tokens (subset of input_tokens billed at the cached rate); 0 when unknown. Written by gateway_finalize_usage from the winning attempt.';
comment on column public.gateway_usage_events.reasoning_tokens is
  'Winning attempt''s reasoning tokens; 0 when unknown or not a reasoning model. Written by gateway_finalize_usage from the winning attempt.';
comment on column public.gateway_usage_events.pricing_known is
  'False when the winning attempt dispatched under an unknown price, so a 0 real cost means "unpriced", not "free". True otherwise (priced, or pre-dispatch with no spend). Written by gateway_finalize_usage.';
comment on column public.gateway_usage_events.failure_class is
  'Winning attempt''s (or pre-dispatch request''s) WMO failure class; null for completed/incomplete. Written by gateway_finalize_usage.';
comment on column public.gateway_usage_events.error_message is
  'Sanitized human-readable failure reason (WMO GatewayFailure.safe_message), names/reasons only, never request content; null for completed/incomplete. Written by gateway_finalize_usage.';

alter table public.gateway_attempts
  add column error_message pg_catalog.text
    check (error_message is null or pg_catalog.char_length(error_message) <= 4096);

comment on column public.gateway_attempts.error_message is
  'Sanitized WMO GatewayFailure.safe_message for this attempt''s failure; null on success. gateway_finalize_usage copies the winning attempt''s value onto the usage event.';

alter table public.gateway_requests
  add column terminal_failure_class pg_catalog.text,
  add column terminal_error_message pg_catalog.text
    check (
      terminal_error_message is null
      or pg_catalog.char_length(terminal_error_message) <= 4096
    );

comment on column public.gateway_requests.terminal_failure_class is
  'Failure class of a request that terminalized BEFORE any dispatch (no attempt to carry it); written by gateway_finish_request, read by gateway_finalize_usage as the fallback outcome reason.';
comment on column public.gateway_requests.terminal_error_message is
  'Sanitized human-readable reason for a pre-dispatch terminal failure; written by gateway_finish_request, read by gateway_finalize_usage as the fallback outcome reason.';

-- ---------------------------------------------------------------------------
-- 2. WRITE WIRE. finalize copies cached/reasoning tokens, pricing_known, and
--    the outcome reason from the winning attempt (falling back to the request's
--    pre-dispatch reason when nothing dispatched). Body otherwise unchanged from
--    20260821110000_gateway_usage_tools.sql.

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
         -- estimated_cost_micro_usd is the attempt's computed cost, which is
         -- NULL exactly when the frozen price was unknown; that is the
         -- pricing_known signal (a settled attempt always has this set).
         (attempts.estimated_cost_micro_usd is not null) as pricing_known,
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
           end), 0)
    into v_attempt_count, v_cost, v_estimated
    from public.gateway_attempts attempts
   where attempts.request_id = p_request_id;
  select keys.created_by into v_user
    from public.api_keys keys
   where keys.id = v_request.api_key_id;
  insert into public.gateway_usage_events (
    request_id, org_id, api_key_id, user_id, alias, provider, lane,
    input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
    cost_micro_usd, estimated_cost_micro_usd, pricing_known,
    latency_ms, status, attempt_count, day, tools_used,
    failure_class, error_message
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
    -- A dispatched attempt is priced unless its computed cost was unknown; a
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
    -- until the WMO runtime surfaces them. Never stored as an empty array.
    case
      when v_winning.tool_names is null then null
      when pg_catalog.cardinality(v_winning.tool_names) = 0 then null
      else v_winning.tool_names
    end,
    -- Outcome reason: the winning attempt's, else the pre-dispatch request's.
    -- A completed/incomplete request has neither.
    coalesce(v_winning.failure_class, v_request.terminal_failure_class),
    coalesce(v_winning.error_message, v_request.terminal_error_message)
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

-- Re-add gateway_settle_attempt with a trailing p_error_message (defaulted NULL
-- so every existing 10-arg caller stays valid) that persists the sanitized
-- failure reason onto the attempt. Body otherwise unchanged from
-- 20260821110000_gateway_usage_tools.sql.
drop function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text[]
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
  p_error_message pg_catalog.text default null
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
    v_settled := case
      when p_state = 'failed' or coalesce(p_output_tokens, 0) = 0 then 0
      else coalesce(v_cost, 0)
    end;
  else
    -- Never charged; the conservative attributed value mirrors WMO's ledger.
    v_settled := coalesce(v_cost, v_attempt.budget_reserved_micro_usd);
  end if;
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
  pg_catalog.bool, pg_catalog.text[], pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text[], pg_catalog.text
) to service_role;

-- Re-add gateway_finish_request with the pre-dispatch outcome reason (both
-- defaulted NULL so the existing 3-arg caller stays valid), stored on the
-- request so gateway_finalize_usage can surface it on the event even though no
-- attempt exists. Body otherwise unchanged from 20260819190000_gateway_runtime.sql.
drop function public.gateway_finish_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text
);

create function public.gateway_finish_request(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_terminal_state pg_catalog.text,
  p_failure_class pg_catalog.text default null,
  p_error_message pg_catalog.text default null
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.gateway_requests%rowtype;
begin
  perform public.gateway_require_service_role();
  if p_terminal_state not in ('failed', 'cancelled') then
    raise exception using errcode = '22023',
      message = 'invalid gateway request terminal state for pre-dispatch finish';
  end if;
  if p_error_message is not null
     and pg_catalog.char_length(p_error_message) > 4096 then
    raise exception using errcode = '22023',
      message = 'gateway request error message exceeds 4096 characters';
  end if;
  select requests.* into v_request
    from public.gateway_requests requests
   where requests.request_id = p_request_id
   for update;
  if v_request.request_id is null then
    raise exception using errcode = 'P0002',
      message = 'gateway request was not durably accepted';
  end if;
  if v_request.org_id <> p_org_id then
    raise exception using errcode = '23514',
      message = 'gateway finish authority differs from the accepted request';
  end if;
  if v_request.terminal_state is not null then
    if v_request.terminal_state = p_terminal_state then
      return;
    end if;
    raise exception using errcode = '23514',
      message = 'gateway request is already settled with another terminal state';
  end if;
  update public.gateway_requests
     set terminal_state = p_terminal_state,
         terminal_at = pg_catalog.clock_timestamp(),
         terminal_failure_class = p_failure_class,
         terminal_error_message = p_error_message
   where request_id = p_request_id;
  perform public.gateway_finalize_usage(p_request_id);
end;
$$;

revoke all on function public.gateway_finish_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_finish_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. READ WIRE. Surface the new event columns through the tenant per-request
--    log. RETURNS TABLE gains trailing columns, so drop and re-create (a return
--    shape cannot change via CREATE OR REPLACE). Body unchanged from
--    20260821120000_gateway_usage_tools_read.sql apart from the new projection.

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
  error_message pg_catalog.text
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
    events.error_message
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
