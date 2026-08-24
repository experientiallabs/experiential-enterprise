-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Tool-call telemetry on the canonical usage stream (schema half). One nullable
-- text[] of the distinct tool NAMES a finished request invoked, carried from
-- the winning attempt into gateway_usage_events. Names only, never arguments or
-- payloads: the ledger stays content-free (see 20260819190000_gateway_runtime.sql).
-- NULL means "not captured" (the winning attempt recorded no tool activity, e.g.
-- the WMO runtime does not yet surface tool names); an empty array is never
-- stored, so NULL and "a request that called no tools" read the same on purpose.
--
-- This is the platform-ready write half: storage plus the settle/finalize wire,
-- all defaulting to NULL. It activates the moment the pinned WMO runtime
-- surfaces tool names on the per-attempt usage payload the worker settles
-- (wmo.runtime.gateway GatewayUsage.tool_names). The tenant read side
-- (list_gateway_usage_events gaining tools_used) is a sibling migration on the
-- gateway usage reads surface, which owns that function.
--
-- Migration prefix 20260821110000 is collision-free across the assembled train
-- union (append-only; no existing object is dropped except to re-add a widened
-- signature below).

-- ---------------------------------------------------------------------------
-- 1. STORAGE. The distinct tool names on the canonical event, and the
--    per-attempt carrier the finalize step reads from the winning attempt
--    (mirroring how input_tokens/output_tokens flow attempt -> event).

alter table public.gateway_usage_events
  add column tools_used pg_catalog.text[];

comment on column public.gateway_usage_events.tools_used is
  'Distinct tool names the finished request invoked, first-use order; names only, no arguments. NULL = not captured (winning attempt recorded no tool activity). Written by gateway_finalize_usage from the winning attempt; read by list_gateway_usage_events.';

alter table public.gateway_attempts
  add column tool_names pg_catalog.text[];

comment on column public.gateway_attempts.tool_names is
  'Distinct tool names this attempt invoked, first-use order; names only. NULL until the WMO runtime surfaces tool names on the settled usage payload. gateway_finalize_usage copies the winning attempt''s value onto the usage event.';

-- ---------------------------------------------------------------------------
-- 2. WRITE WIRE. Re-add gateway_settle_attempt with a trailing p_tool_names
--    (defaulted NULL so every existing caller stays valid) that persists onto
--    the attempt, and gateway_finalize_usage now copies the winning attempt's
--    tool_names onto the usage event. Bodies are otherwise unchanged from
--    20260819190000_gateway_runtime.sql.

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
         attempts.tool_names
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
    input_tokens, output_tokens, cost_micro_usd, estimated_cost_micro_usd,
    latency_ms, status, attempt_count, day, tools_used
  ) values (
    p_request_id, v_request.org_id, v_request.api_key_id, v_user,
    v_request.alias, v_winning.provider,
    case v_winning.billing_source
      when 'host_managed' then 'platform_funded'
      when 'customer_managed' then 'pass_through'
      else null
    end,
    coalesce(v_winning.input_tokens, 0), coalesce(v_winning.output_tokens, 0),
    v_cost, v_estimated,
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
    end
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

-- The 9-arg settle signature is superseded by the 10-arg one below; drop it so
-- exactly one function remains (a defaulted 10th param resolves every existing
-- 9-arg call, so callers need no change to stay valid).
drop function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool
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
  p_tool_names pg_catalog.text[] default null
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
         end
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
  pg_catalog.bool, pg_catalog.text[]
) from public, anon, authenticated;
grant execute on function public.gateway_settle_attempt(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.int4,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.int4, pg_catalog.text,
  pg_catalog.bool, pg_catalog.text[]
) to service_role;
