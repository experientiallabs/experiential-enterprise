-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Fix pricing_known on the canonical usage event: a FAILED/cancelled request on
-- a FULLY PRICED route must settle pricing_known=true (real cost $0.00), not
-- "unpriced".
--
-- 20260821200000_gateway_usage_metadata_errors.sql derived
-- ``pricing_known := (attempts.estimated_cost_micro_usd is not null)``. But
-- ``gateway_attempt_cost_micro_usd`` returns NULL whenever usage is absent
-- (both input and output tokens null) -- which is exactly what
-- ``finish_attempt`` (explabs/gateway/ledger.py) passes on the ordinary FAILURE
-- path (no terminal event -> usage None -> usage_source='unknown', every token
-- count null). So a failed call on a priced route settled with
-- estimated_cost_micro_usd=null and read back as pricing_known=false, and the
-- Telemetry cost cell rendered "unpriced" instead of $0.00 for essentially every
-- failed request.
--
-- The correct signal for "this route is priced" is the FROZEN BASE RATES on the
-- winning attempt, not the computed cost. Rates are frozen at dispatch
-- (input_rate_micro_usd / output_rate_micro_usd; null = unknown price, see
-- 20260819190000_gateway_runtime.sql). A host-lane attempt can never dispatch
-- under an unknown price (gateway_start_attempt raises deployment_price_unknown),
-- so a null base rate means a genuinely unpriced BYOK route -- the only case that
-- should read as "unpriced". A failed call keeps its route's rates regardless of
-- whether any usage was observed, so it now reads priced-known with cost $0.00.
--
-- This is a pure re-definition of gateway_finalize_usage; last redefinition wins
-- (migration-ordering rule). Signature and body are unchanged from
-- 20260821200000 except the pricing_known derivation, so CREATE OR REPLACE is
-- sufficient (no return-shape or argument change). Migration prefix 20260821220000
-- is collision-free and later than every existing finalize definition.

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
