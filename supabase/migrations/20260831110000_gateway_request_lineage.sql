-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Content-free request lineage: which requests share a prompt or a
-- conversation. The worker's control store derives three values from the
-- canonical request at authorize time (explabs/gateway/lineage.py) and the
-- ledger persists them at accept:
--
--   prompt_sha256        digest of the STABLE PROMPT PREFIX: every
--                        system/developer message plus the caller-defined tool
--                        declarations. Requests sharing it run the same agent
--                        configuration — exactly the prefix a provider prompt
--                        cache can serve.
--   conversation_sha256  prompt basis plus the first user message; multi-turn
--                        agents resend the seed turn verbatim, so turns of one
--                        conversation group together with no session state.
--   stable_prefix_chars  character length of the stable prefix. Consumers
--                        derive an ESTIMATED token count and must label it.
--
-- The ledger stays content-free: only digests and a length land here
-- (gateway_requests.content_retained = 0 is untouched). All three are null
-- for rows accepted before this migration, for replays of another worker's
-- request, and for surfaces where the caller sent no messages.
--
-- Named consumers in the same change: the request-log grouping in Telemetry
-- (list_gateway_usage_events trailing columns), the per-prompt rollup RPC
-- (gateway_usage_by_prompt) behind the Insights "repeated prompts" card, and
-- the suggestions engine's prompt-caching workflow (explabs/api/suggestions.py),
-- which now checks the ACTUAL repeated prefix instead of assuming one.
--
-- Migration prefix 20260831110000 is collision-free across the assembled
-- train union (append-only; drops only re-add widened signatures/shapes).

-- ---------------------------------------------------------------------------
-- 1. STORAGE. Lineage on the accepted request (written at accept) and on the
--    canonical usage event (copied at finalize, like every request-level
--    attribute the tenant surface reads).

alter table public.gateway_requests
  add column prompt_sha256 pg_catalog.text
    check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  add column conversation_sha256 pg_catalog.text
    check (conversation_sha256 ~ '^[0-9a-f]{64}$'),
  add column stable_prefix_chars pg_catalog.int8
    check (stable_prefix_chars >= 0);

comment on column public.gateway_requests.prompt_sha256 is
  'Content-free digest of the stable prompt prefix (system/developer messages + tool declarations). Requests sharing it run the same agent configuration. Null = accepted before lineage existed, replayed from another worker, or no messages.';
comment on column public.gateway_requests.conversation_sha256 is
  'Content-free digest of the prompt prefix plus the first user message; groups the turns of one conversation. Null under the same conditions as prompt_sha256.';
comment on column public.gateway_requests.stable_prefix_chars is
  'Character length of the stable prompt prefix; consumers derive an ESTIMATED token count and must label it as an estimate.';

alter table public.gateway_usage_events
  add column prompt_sha256 pg_catalog.text
    check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  add column conversation_sha256 pg_catalog.text
    check (conversation_sha256 ~ '^[0-9a-f]{64}$'),
  add column stable_prefix_chars pg_catalog.int8
    check (stable_prefix_chars >= 0);

comment on column public.gateway_usage_events.prompt_sha256 is
  'Copied from gateway_requests at finalize; see that column. Read by list_gateway_usage_events and gateway_usage_by_prompt.';
comment on column public.gateway_usage_events.conversation_sha256 is
  'Copied from gateway_requests at finalize; see that column.';
comment on column public.gateway_usage_events.stable_prefix_chars is
  'Copied from gateway_requests at finalize; see that column.';

-- ---------------------------------------------------------------------------
-- 2. WRITE WIRE (accept). Re-add gateway_accept_request with three trailing
--    defaulted lineage params so every existing caller stays valid during the
--    roll. Body otherwise unchanged from
--    20260821230000_gateway_accept_request_reclaim_crashed_null.sql; the
--    replay-receipt drift check deliberately ignores lineage (a replay from a
--    worker without the in-process lineage entry sends nulls for the same
--    content and must stay a no-op, never a 23505).

drop function public.gateway_accept_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz
);

create function public.gateway_accept_request(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_api_key_id pg_catalog.uuid,
  p_alias pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_canonical_request_sha256 pg_catalog.text,
  p_caller_operation_sha256 pg_catalog.text,
  p_deadline_at pg_catalog.timestamptz,
  p_prompt_sha256 pg_catalog.text default null,
  p_conversation_sha256 pg_catalog.text default null,
  p_stable_prefix_chars pg_catalog.int8 default null
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior record;
  v_existing public.gateway_requests%rowtype;
  v_reclaimable pg_catalog.bool;
begin
  perform public.gateway_require_service_role();
  if p_deadline_at is null then
    raise exception using errcode = '22023',
      message = 'accepted gateway request requires a deadline';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = p_api_key_id and keys.org_id = p_org_id
  ) then
    raise exception using errcode = '42501',
      message = 'gateway request key attribution is invalid';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = p_api_key_id
      and keys.revoked_at is null
      and (keys.expires_at is null
        or keys.expires_at > pg_catalog.clock_timestamp())
  ) then
    raise exception using errcode = '42501',
      message = 'gateway request api key is revoked or expired';
  end if;
  -- Replay receipt: a retried accept RPC (worker retried after a lost
  -- response) is a no-op when the durable row matches; drifted content under
  -- the same request id is refused with a typed conflict, never a raw
  -- constraint error. Lineage is derived from the same content and may be
  -- absent on a replay, so it takes no part in the drift comparison.
  select requests.* into v_existing
    from public.gateway_requests requests
   where requests.request_id = p_request_id;
  if v_existing.request_id is not null then
    if v_existing.org_id <> p_org_id
       or v_existing.api_key_id is distinct from p_api_key_id
       or v_existing.alias_revision_id <> p_alias_revision_id
       or v_existing.api_surface <> p_api_surface
       or v_existing.canonical_request_sha256 <> p_canonical_request_sha256
       or v_existing.caller_operation_sha256
         is distinct from p_caller_operation_sha256 then
      raise exception using errcode = '23505',
        message = 'gateway request id is bound to different accepted content';
    end if;
    return;
  end if;
  if p_caller_operation_sha256 is not null then
    -- Serialize concurrent accepts of the same caller operation: without
    -- this, two simultaneous submissions with one Idempotency-Key both pass
    -- the probe below (neither sees the other's uncommitted insert) and the
    -- operation dispatches — and charges — twice.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'gateway_accept_request:' || p_org_id::pg_catalog.text || ':'
        || p_alias_revision_id || ':' || p_api_surface || ':'
        || p_caller_operation_sha256,
        0
      )
    );
    select requests.canonical_request_sha256,
           requests.terminal_state,
           requests.deadline_at
      into v_prior
      from public.gateway_requests requests
     where requests.org_id = p_org_id
       and requests.alias_revision_id = p_alias_revision_id
       and requests.api_surface = p_api_surface
       and requests.caller_operation_sha256 = p_caller_operation_sha256
     order by requests.accepted_at desc
     limit 1;
    if v_prior.canonical_request_sha256 is not null then
      if v_prior.canonical_request_sha256 <> p_canonical_request_sha256 then
        raise exception using errcode = 'P1020',
          message = 'idempotency_conflict: the caller operation key was reused '
            || 'with different request content; mint a new Idempotency-Key';
      end if;
      -- Reclaimable iff the prior is a dead owner: a crash-reconciled state, or
      -- a never-terminal row whose own deadline has already passed. `coalesce`
      -- keeps a still-in-flight NULL prior (deadline in the future) fail-closed
      -- rather than letting the SQL three-valued `and`/`or` fall through.
      v_reclaimable := coalesce(
        v_prior.terminal_state in (
          'expired_before_dispatch', 'unknown_after_crash'
        )
        or (
          v_prior.terminal_state is null
          and v_prior.deadline_at < pg_catalog.clock_timestamp()
        ),
        false
      );
      if not v_reclaimable then
        raise exception using errcode = 'P1021',
          message = 'idempotency_replay_unavailable: a matching keyed request '
            || 'exists but durable content replay is unavailable; resend the '
            || 'full request with a new Idempotency-Key';
      end if;
    end if;
  end if;
  insert into public.gateway_requests (
    request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
    canonical_request_sha256, caller_operation_sha256, accepted_at, deadline_at,
    prompt_sha256, conversation_sha256, stable_prefix_chars
  ) values (
    p_request_id, p_org_id, p_api_key_id, p_alias, p_alias_revision_id,
    p_api_surface, p_canonical_request_sha256, p_caller_operation_sha256,
    pg_catalog.clock_timestamp(), p_deadline_at,
    p_prompt_sha256, p_conversation_sha256, p_stable_prefix_chars
  );
end;
$$;

revoke all on function public.gateway_accept_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.gateway_accept_request(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.timestamptz, pg_catalog.text, pg_catalog.text, pg_catalog.int8
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. WRITE WIRE (finalize). Copy the request's lineage onto the usage event.
--    Body otherwise unchanged from 20260828220000_gateway_ttft.sql.

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
    generation_duration_ms, routing_overhead_ms, ttft_ms,
    prompt_sha256, conversation_sha256, stable_prefix_chars
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
    v_generation_ms, v_routing_ms, v_ttft_ms,
    -- Lineage rides the request row (written at accept), not the attempt.
    v_request.prompt_sha256, v_request.conversation_sha256,
    v_request.stable_prefix_chars
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
-- 4. READ WIRE (request log). Trailing lineage columns on the per-request log;
--    body unchanged from 20260828220000_gateway_ttft.sql apart from the
--    projection. Return shape changes, so drop and re-create.

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
  ttft_ms pg_catalog.int4,
  prompt_sha256 pg_catalog.text,
  conversation_sha256 pg_catalog.text,
  stable_prefix_chars pg_catalog.int8
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
    events.ttft_ms,
    events.prompt_sha256,
    events.conversation_sha256,
    events.stable_prefix_chars
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

-- ---------------------------------------------------------------------------
-- 5. READ WIRE (per-prompt rollup). One row per (prompt_sha256, alias) the org
--    exercised in the window: the base for the Insights "repeated prompts"
--    card and the suggestions engine's prompt-caching workflow. Rows accepted
--    before lineage existed (prompt_sha256 null) are excluded — an honest
--    rollup over exactly the requests whose lineage is known.

create function public.gateway_usage_by_prompt(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null
)
returns table (
  prompt_sha256 pg_catalog.text,
  alias pg_catalog.text,
  request_count pg_catalog.int8,
  error_count pg_catalog.int8,
  conversation_count pg_catalog.int8,
  agent_count pg_catalog.int8,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cached_input_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
  stable_prefix_chars pg_catalog.int8,
  last_used_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    events.prompt_sha256,
    events.alias,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    (pg_catalog.count(*) filter (where events.status <> 'completed')
      )::pg_catalog.int8 as error_count,
    pg_catalog.count(distinct events.conversation_sha256)::pg_catalog.int8
      as conversation_count,
    pg_catalog.count(distinct events.api_key_id)::pg_catalog.int8 as agent_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as input_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as output_tokens,
    coalesce(pg_catalog.sum(events.cached_input_tokens), 0)::pg_catalog.int8
      as cached_input_tokens,
    coalesce(pg_catalog.sum(events.cost_micro_usd), 0)::pg_catalog.int8
      as cost_micro_usd,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd,
    -- One prompt digest fixes one prefix; max() collapses the identical values.
    coalesce(pg_catalog.max(events.stable_prefix_chars), 0)::pg_catalog.int8
      as stable_prefix_chars,
    pg_catalog.max(events.created_at) as last_used_at
  from public.gateway_usage_events events
  where events.org_id = in_org
    and events.prompt_sha256 is not null
    and (in_after is null or events.created_at >= in_after)
  group by events.prompt_sha256, events.alias
  -- Bounded to the PostgREST max_rows cap by descending traffic, matching
  -- gateway_usage_by_key: the highest-volume prompts are retained
  -- deterministically instead of an arbitrary truncated page.
  order by pg_catalog.count(*) desc, events.prompt_sha256, events.alias
  limit 1000;
end;
$$;

revoke all on function public.gateway_usage_by_prompt(
  pg_catalog.uuid, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.gateway_usage_by_prompt(
  pg_catalog.uuid, pg_catalog.timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- 6. WRITE WIRE (deferred accept fold). gateway_accept_and_start_attempt
--    (20260830100000) forwards positionally into gateway_accept_request, and
--    its MERGE-TRAIN FLAG requires any migration changing an inner function's
--    signature to recompose the fold in the same migration. The keyless hot
--    path persists its accept HERE, so without this recompose the
--    overwhelming majority of requests would carry null lineage. Body
--    otherwise unchanged from 20260830100000; the three trailing lineage
--    params default to null so every existing caller stays valid.

drop function public.gateway_accept_and_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8
);

create function public.gateway_accept_and_start_attempt(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_api_key_id pg_catalog.uuid,
  p_alias pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_canonical_request_sha256 pg_catalog.text,
  p_deadline_at pg_catalog.timestamptz,
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
  p_maximum_cost_micro_usd pg_catalog.int8,
  p_prompt_sha256 pg_catalog.text default null,
  p_conversation_sha256 pg_catalog.text default null,
  p_stable_prefix_chars pg_catalog.int8 default null
)
returns table (attempt_id pg_catalog.text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock ordering. gateway_start_attempt serializes host-lane money decisions
  -- with FOR UPDATE on the organizations row, while the accept's insert takes
  -- a weaker KEY SHARE on that same row (the org_id foreign key). Folded into
  -- one transaction and raced against a sibling fold for the same org, that
  -- is a share-then-exclusive upgrade on both sides — a guaranteed deadlock
  -- pair. Take the reservation's exclusive lock FIRST, so concurrent folds
  -- queue in the same order the money gate already imposes. Customer-managed
  -- lanes reserve nothing and take no exclusive org lock, so they keep their
  -- lock-free concurrency.
  if p_billing_source = 'host_managed' then
    perform 1 from public.organizations orgs
     where orgs.id = p_org_id
     for update;
  end if;
  -- No p_caller_operation parameter exists on purpose: the fold is only
  -- sound when no caller-operation idempotency semantics are in play. The
  -- accept below always records a NULL caller operation, so its P1020/P1021
  -- branch is structurally unreachable here.
  perform public.gateway_accept_request(
    p_request_id,
    p_org_id,
    p_api_key_id,
    p_alias,
    p_alias_revision_id,
    p_api_surface,
    p_canonical_request_sha256,
    null,
    p_deadline_at,
    p_prompt_sha256,
    p_conversation_sha256,
    p_stable_prefix_chars
  );
  return query select s.attempt_id from public.gateway_start_attempt(
    p_request_id,
    p_org_id,
    p_attempt_ordinal,
    p_route_depth,
    p_deployment_id,
    p_provider,
    p_exact_model_id,
    p_pool_id,
    p_catalog_sha256,
    p_billing_source,
    p_pricing_source,
    p_pricing_effective_at,
    p_input_rate_micro_usd,
    p_cached_input_rate_micro_usd,
    p_output_rate_micro_usd,
    p_reasoning_rate_micro_usd,
    p_maximum_cost_micro_usd
  ) s;
end;
$$;

revoke all on function public.gateway_accept_and_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.int8
) from public, anon, authenticated;
grant execute on function public.gateway_accept_and_start_attempt(
  pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.timestamptz,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text,
  pg_catalog.text, pg_catalog.timestamptz, pg_catalog.int8, pg_catalog.int8,
  pg_catalog.int8, pg_catalog.int8, pg_catalog.int8, pg_catalog.text,
  pg_catalog.text, pg_catalog.int8
) to service_role;
