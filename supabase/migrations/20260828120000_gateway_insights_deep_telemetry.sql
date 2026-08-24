-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Deep telemetry: request timing on the canonical usage stream + the per-org
-- Insights aggregation read layer. Two halves.
--
--   1. WRITE HALF. Two additive timing columns on gateway_usage_events, carried
--      from the attempts of the finished request in the settlement transaction,
--      exactly like input_tokens/cached_input_tokens/reasoning_tokens/tools_used
--      already are (see 20260819190000_gateway_runtime.sql,
--      20260821110000_gateway_usage_tools.sql, and
--      20260821200000_gateway_usage_metadata_errors.sql):
--
--        generation_duration_ms  winning attempt started_at -> terminal_at, ms;
--                                the tok/s denominator (output_tokens / this)
--        routing_overhead_ms     request accepted_at -> FIRST attempt started_at,
--                                ms; the time the gateway spent selecting a route
--                                and reserving budget before the first upstream
--                                dispatch
--
--      Both derive from timestamps the ledger ALREADY persists
--      (gateway_attempts.started_at / terminal_at, gateway_requests.accepted_at),
--      so this migration re-creates only gateway_finalize_usage to stamp them onto
--      the event; gateway_settle_attempt is untouched. The token breakdown
--      (prompt=input, completion=output, reasoning, cached) already lands on the
--      event from prior migrations, so it is NOT re-added here.
--
--      NOT captured here, by design (both need an Experiential/WMO runtime change
--      and are reported at the seam, not guessed):
--        * time-to-first-token (TTFT): the first upstream token arrives inside the
--          runtime's streaming executor; the platform's AttemptLedger seam
--          (explabs/gateway/ledger.py) only observes accept / start / finish,
--          never a first-token event. The runtime would add a first_token_at to
--          GatewayUsage (or a record_first_token ledger callback); the platform
--          would then store it on gateway_attempts and subtract accepted_at here,
--          and generation_duration_ms would narrow to first_token_at ->
--          terminal_at.
--        * header-based app attribution (HTTP-Referer / X-Title): parsed inside
--          the runtime's app; AuthorizationSnapshot carries no app label. Until
--          the runtime surfaces one, gateway_insights_top_apps attributes by API
--          KEY label (api_keys.name), an accepted attribution source available
--          today.
--
--   2. READ HALF. Three org-scoped, service-role read RPCs over the canonical
--      gateway_usage_events store (never the raw attempts table, keeping the
--      cross-team read contract intact) that back the deep "Insights" page (data
--      layer only; the page itself is built separately in PR #665):
--        gateway_insights_metrics            windowed aggregates grouped by day,
--                                            model, or provider (cache-hit rate,
--                                            aggregate tok/s, avg routing/
--                                            generation/latency, token breakdown)
--        gateway_insights_tokens_per_second  tok/s bucketed over time
--        gateway_insights_top_apps           per-(API key) attribution ranking
--
-- Migration prefix 20260828120000 is later than every existing gateway migration
-- and drops no existing object; it re-creates gateway_finalize_usage in place
-- (last redefinition wins, migration-ordering rule), preserving the
-- 20260821220000 body verbatim except for the two new timing fields.

-- ---------------------------------------------------------------------------
-- 1. STORAGE. Two additive timing columns on the canonical per-request event.
--    NULL when nothing was dispatched (no attempt to time).

alter table public.gateway_usage_events
  add column generation_duration_ms pg_catalog.int4
    check (generation_duration_ms is null or generation_duration_ms >= 0),
  add column routing_overhead_ms pg_catalog.int4
    check (routing_overhead_ms is null or routing_overhead_ms >= 0);

comment on column public.gateway_usage_events.generation_duration_ms is
  'Winning attempt started_at -> terminal_at, milliseconds; the tok/s denominator. NULL when nothing was dispatched. Written by gateway_finalize_usage.';
comment on column public.gateway_usage_events.routing_overhead_ms is
  'Request accepted_at -> first attempt started_at, milliseconds: gateway route selection + budget reservation before the first upstream dispatch. NULL when nothing was dispatched. Written by gateway_finalize_usage.';

-- ---------------------------------------------------------------------------
-- 2. WRITE WIRE. Re-create gateway_finalize_usage to additionally stamp the two
--    timing columns. Body is identical to
--    20260821220000_gateway_finalize_pricing_known_from_frozen_rates.sql except
--    for the winning-attempt timestamps, the first-dispatch minimum, and the two
--    derived fields on the insert.

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

  insert into public.gateway_usage_events (
    request_id, org_id, api_key_id, user_id, alias, provider, lane,
    input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
    cost_micro_usd, estimated_cost_micro_usd, pricing_known,
    latency_ms, status, attempt_count, day, tools_used,
    failure_class, error_message,
    generation_duration_ms, routing_overhead_ms
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
    v_generation_ms, v_routing_ms
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
-- 3. READ HALF. Deep Insights aggregation over the canonical store.
--    Semantics shared with 20260819233500_gateway_usage_reads.sql:
--      * request_count counts every FINISHED request; error_count is the subset
--        whose terminal state is not 'completed'.
--      * duration/rate aggregates ignore rows with no dispatch (NULL duration),
--        so a pre-dispatch failure never drags an average toward zero.
--      * money keeps the ledger's integer micro-USD charged/estimated split.
--      * every read is org-scoped and returns nothing for another org.

-- 3a. Windowed aggregates grouped by day, model, or provider.
create function public.gateway_insights_metrics(
  in_org pg_catalog.uuid,
  in_group_by pg_catalog.text default 'day',
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_bucket_seconds pg_catalog.int4 default 86400
)
returns table (
  bucket_key pg_catalog.text,
  request_count pg_catalog.int8,
  completed_count pg_catalog.int8,
  error_count pg_catalog.int8,
  prompt_tokens pg_catalog.int8,
  completion_tokens pg_catalog.int8,
  reasoning_tokens pg_catalog.int8,
  cached_input_tokens pg_catalog.int8,
  cache_hit_rate pg_catalog.numeric,
  tokens_per_second pg_catalog.numeric,
  avg_generation_duration_ms pg_catalog.numeric,
  avg_routing_overhead_ms pg_catalog.numeric,
  avg_latency_ms pg_catalog.numeric,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  step pg_catalog.int4 := greatest(coalesce(in_bucket_seconds, 86400), 60);
begin
  if in_group_by not in ('day', 'model', 'provider') then
    raise exception using errcode = '22023',
      message = 'invalid gateway insights group_by (expected day, model, or provider)';
  end if;
  return query
  select
    case in_group_by
      when 'day' then pg_catalog.to_char(
        pg_catalog.to_timestamp(
          pg_catalog.floor(extract(epoch from events.created_at) / step) * step
        ) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      )
      when 'model' then events.alias
      else coalesce(events.provider, '(no dispatch)')
    end as bucket_key,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    (pg_catalog.count(*) filter (where events.status = 'completed')
      )::pg_catalog.int8 as completed_count,
    (pg_catalog.count(*) filter (where events.status <> 'completed')
      )::pg_catalog.int8 as error_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as prompt_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as completion_tokens,
    coalesce(pg_catalog.sum(events.reasoning_tokens), 0)::pg_catalog.int8
      as reasoning_tokens,
    coalesce(pg_catalog.sum(events.cached_input_tokens), 0)::pg_catalog.int8
      as cached_input_tokens,
    -- Cache-hit rate = cached input / total input, NULL when no input tokens.
    (pg_catalog.sum(events.cached_input_tokens)::pg_catalog.numeric
      / nullif(pg_catalog.sum(events.input_tokens), 0))
      as cache_hit_rate,
    -- Aggregate tok/s = total completion tokens / total generation seconds, over
    -- rows that were dispatched (non-null duration) only.
    (pg_catalog.sum(events.output_tokens) filter (
        where events.generation_duration_ms is not null
      )::pg_catalog.numeric
      / nullif(
          pg_catalog.sum(events.generation_duration_ms)::pg_catalog.numeric
            / 1000, 0))
      as tokens_per_second,
    pg_catalog.avg(events.generation_duration_ms) as avg_generation_duration_ms,
    pg_catalog.avg(events.routing_overhead_ms) as avg_routing_overhead_ms,
    pg_catalog.avg(events.latency_ms) as avg_latency_ms,
    coalesce(pg_catalog.sum(events.cost_micro_usd), 0)::pg_catalog.int8
      as cost_micro_usd,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd
  from public.gateway_usage_events events
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
    and (in_before is null or events.created_at < in_before)
  group by 1
  order by 1;
end;
$$;

revoke all on function public.gateway_insights_metrics(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.timestamptz, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_insights_metrics(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.timestamptz, pg_catalog.int4
) to service_role;

-- 3b. tok/s over time: completion tokens divided by generation seconds per time
--     bucket. Dispatched rows only, so a pre-dispatch failure contributes no
--     phantom zero-throughput point.
create function public.gateway_insights_tokens_per_second(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_bucket_seconds pg_catalog.int4 default 3600,
  in_alias pg_catalog.text default null,
  in_provider pg_catalog.text default null
)
returns table (
  bucket_start pg_catalog.timestamptz,
  request_count pg_catalog.int8,
  completion_tokens pg_catalog.int8,
  generation_ms pg_catalog.int8,
  tokens_per_second pg_catalog.numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  step pg_catalog.int4 := greatest(coalesce(in_bucket_seconds, 3600), 60);
begin
  return query
  select
    pg_catalog.to_timestamp(
      pg_catalog.floor(extract(epoch from events.created_at) / step) * step
    ) as bucket_start,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as completion_tokens,
    coalesce(pg_catalog.sum(events.generation_duration_ms), 0)::pg_catalog.int8
      as generation_ms,
    (pg_catalog.sum(events.output_tokens)::pg_catalog.numeric
      / nullif(
          pg_catalog.sum(events.generation_duration_ms)::pg_catalog.numeric
            / 1000, 0))
      as tokens_per_second
  from public.gateway_usage_events events
  where events.org_id = in_org
    and events.generation_duration_ms is not null
    and (in_after is null or events.created_at >= in_after)
    and (in_before is null or events.created_at < in_before)
    and (in_alias is null or events.alias = in_alias)
    and (in_provider is null or events.provider = in_provider)
  group by 1
  order by 1;
end;
$$;

revoke all on function public.gateway_insights_tokens_per_second(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_insights_tokens_per_second(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.text, pg_catalog.text
) to service_role;

-- 3c. Top apps by attribution. Until the runtime surfaces an HTTP-Referer/X-Title
--     app label, the attribution unit is the API KEY (api_keys.name), an accepted
--     source available today. A key deleted after settlement keeps its history
--     under a null label (the event's api_key_id is a snapshot with no foreign
--     key).
create function public.gateway_insights_top_apps(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null,
  in_before pg_catalog.timestamptz default null,
  in_limit pg_catalog.int4 default 20
)
returns table (
  api_key_id pg_catalog.uuid,
  app_label pg_catalog.text,
  request_count pg_catalog.int8,
  error_count pg_catalog.int8,
  prompt_tokens pg_catalog.int8,
  completion_tokens pg_catalog.int8,
  reasoning_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
  last_used_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 20), 1), 100);
begin
  return query
  select
    events.api_key_id,
    keys.name as app_label,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    (pg_catalog.count(*) filter (where events.status <> 'completed')
      )::pg_catalog.int8 as error_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as prompt_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as completion_tokens,
    coalesce(pg_catalog.sum(events.reasoning_tokens), 0)::pg_catalog.int8
      as reasoning_tokens,
    coalesce(pg_catalog.sum(events.cost_micro_usd), 0)::pg_catalog.int8
      as cost_micro_usd,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd,
    pg_catalog.max(events.created_at) as last_used_at
  from public.gateway_usage_events events
  left join public.api_keys keys on keys.id = events.api_key_id
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
    and (in_before is null or events.created_at < in_before)
  group by events.api_key_id, keys.name
  order by pg_catalog.count(*) desc, events.api_key_id
  limit cap;
end;
$$;

revoke all on function public.gateway_insights_top_apps(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_insights_top_apps(
  pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz, pg_catalog.int4
) to service_role;
