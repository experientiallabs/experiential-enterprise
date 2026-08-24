-- Gateway control-API read paths (integration-P5). Read-only companions to
-- the gateway runtime schema: the control API serves usage, key-limit, and
-- catalog reads through these so every query is one indexed statement inside
-- Postgres (the Overview page's rollup must answer all-time ranges cheaply).
-- Nothing here writes; the sanctioned write paths stay in the runtime
-- migration (gateway_key_limits remains the control API's direct-write table).

-- Grouped rollup read over gateway_usage_daily for the account Overview page
-- and the org usage views. Groupings:
--   day    -> per-day totals (the Overview time series; pass in_user for the
--             per-user shape — a user's numbers already sum across all of
--             their keys because the rollup buckets by user, not key)
--   model  -> per-alias totals ordered by spend (top-models lists)
--   member -> per-user totals ordered by spend (org breakdowns; the zero
--             uuid bucket carries usage whose key had no recorded creator)
create function public.gateway_usage_daily_read(
  in_org pg_catalog.uuid,
  in_user pg_catalog.uuid default null,
  in_from pg_catalog.date default null,
  in_to pg_catalog.date default null,
  in_group_by pg_catalog.text default 'day',
  in_limit pg_catalog.int4 default 400
)
returns table (
  day pg_catalog.date,
  user_id pg_catalog.uuid,
  alias pg_catalog.text,
  requests pg_catalog.int8,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  spend_micro_usd pg_catalog.int8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 400), 1), 2000);
begin
  perform public.gateway_require_service_role();
  if in_group_by = 'day' then
    return query
    select daily.day, null::pg_catalog.uuid, null::pg_catalog.text,
           pg_catalog.sum(daily.requests)::pg_catalog.int8,
           pg_catalog.sum(daily.input_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.output_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.spend_micro_usd)::pg_catalog.int8
      from public.gateway_usage_daily daily
     where daily.org_id = in_org
       and (in_user is null or daily.user_id = in_user)
       and (in_from is null or daily.day >= in_from)
       and (in_to is null or daily.day <= in_to)
     group by daily.day
     order by daily.day desc
     limit cap;
  elsif in_group_by = 'model' then
    return query
    select null::pg_catalog.date, null::pg_catalog.uuid, daily.alias,
           pg_catalog.sum(daily.requests)::pg_catalog.int8,
           pg_catalog.sum(daily.input_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.output_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.spend_micro_usd)::pg_catalog.int8
      from public.gateway_usage_daily daily
     where daily.org_id = in_org
       and (in_user is null or daily.user_id = in_user)
       and (in_from is null or daily.day >= in_from)
       and (in_to is null or daily.day <= in_to)
     group by daily.alias
     order by pg_catalog.sum(daily.spend_micro_usd) desc, daily.alias
     limit cap;
  elsif in_group_by = 'member' then
    return query
    select null::pg_catalog.date, daily.user_id, null::pg_catalog.text,
           pg_catalog.sum(daily.requests)::pg_catalog.int8,
           pg_catalog.sum(daily.input_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.output_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.spend_micro_usd)::pg_catalog.int8
      from public.gateway_usage_daily daily
     where daily.org_id = in_org
       and (in_user is null or daily.user_id = in_user)
       and (in_from is null or daily.day >= in_from)
       and (in_to is null or daily.day <= in_to)
     group by daily.user_id
     order by pg_catalog.sum(daily.spend_micro_usd) desc, daily.user_id
     limit cap;
  else
    raise exception using errcode = '22023',
      message = 'invalid gateway usage grouping (expected day, model, or member)';
  end if;
end;
$$;

revoke all on function public.gateway_usage_daily_read(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.date, pg_catalog.date,
  pg_catalog.text, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_usage_daily_read(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.date, pg_catalog.date,
  pg_catalog.text, pg_catalog.int4
) to service_role;

-- Keyset-paginated event read (gateway_usage_events is append-only and
-- unbounded, so offset pagination would degrade linearly). Order and cursor
-- are (day desc, created_at desc, request_id desc): day-leading matches the
-- (org_id, day, created_at) index, and request_id makes the cursor total.
-- org_id is omitted from the output because the caller scoped the query.
create function public.gateway_usage_events_read(
  in_org pg_catalog.uuid,
  in_api_key pg_catalog.uuid default null,
  in_from pg_catalog.date default null,
  in_to pg_catalog.date default null,
  in_cursor_day pg_catalog.date default null,
  in_cursor_created pg_catalog.timestamptz default null,
  in_cursor_request pg_catalog.text default null,
  in_limit pg_catalog.int4 default 50
)
returns table (
  request_id pg_catalog.text,
  api_key_id pg_catalog.uuid,
  user_id pg_catalog.uuid,
  alias pg_catalog.text,
  provider pg_catalog.text,
  lane pg_catalog.text,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
  latency_ms pg_catalog.int4,
  status pg_catalog.text,
  attempt_count pg_catalog.int4,
  day pg_catalog.date,
  created_at pg_catalog.timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap pg_catalog.int4 := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  perform public.gateway_require_service_role();
  return query
  select events.request_id, events.api_key_id, events.user_id, events.alias,
         events.provider, events.lane, events.input_tokens, events.output_tokens,
         events.cost_micro_usd, events.estimated_cost_micro_usd,
         events.latency_ms, events.status, events.attempt_count, events.day,
         events.created_at
    from public.gateway_usage_events events
   where events.org_id = in_org
     and (in_api_key is null or events.api_key_id = in_api_key)
     and (in_from is null or events.day >= in_from)
     and (in_to is null or events.day <= in_to)
     and (
       in_cursor_day is null
       or in_cursor_created is null
       or in_cursor_request is null
       or (events.day, events.created_at, events.request_id)
         < (in_cursor_day, in_cursor_created, in_cursor_request)
     )
   order by events.day desc, events.created_at desc, events.request_id desc
   limit cap;
end;
$$;

revoke all on function public.gateway_usage_events_read(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.date, pg_catalog.date,
  pg_catalog.date, pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_usage_events_read(
  pg_catalog.uuid, pg_catalog.uuid, pg_catalog.date, pg_catalog.date,
  pg_catalog.date, pg_catalog.timestamptz, pg_catalog.text, pg_catalog.int4
) to service_role;

-- Effective per-key guardrails: the explicit gateway_key_limits row when one
-- exists, otherwise the same defaults gateway_start_attempt enforces (rpm 60;
-- a $50/day cap only while the org is free-credit funded). The no-row default
-- arms here and in gateway_start_attempt MUST stay in lockstep — change both
-- or neither.
create function public.gateway_key_limits_effective(in_api_key pg_catalog.uuid)
returns table (
  api_key_id pg_catalog.uuid,
  daily_spend_cap_micro_usd pg_catalog.int8,
  requests_per_minute pg_catalog.int4,
  source pg_catalog.text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org pg_catalog.uuid;
  v_limits public.gateway_key_limits%rowtype;
begin
  perform public.gateway_require_service_role();
  select keys.org_id into v_org
    from public.api_keys keys
   where keys.id = in_api_key;
  if v_org is null then
    raise exception using errcode = 'P0002',
      message = 'api key does not exist';
  end if;
  select limits.* into v_limits
    from public.gateway_key_limits limits
   where limits.api_key_id = in_api_key;
  if v_limits.api_key_id is not null then
    return query select in_api_key, v_limits.daily_spend_cap_micro_usd,
      v_limits.requests_per_minute, 'explicit'::pg_catalog.text;
    return;
  end if;
  return query select in_api_key,
    case
      when public.gateway_org_free_credit_funded(v_org)
        then 50000000::pg_catalog.int8
      else null::pg_catalog.int8
    end,
    60, 'default'::pg_catalog.text;
end;
$$;

revoke all on function public.gateway_key_limits_effective(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.gateway_key_limits_effective(pg_catalog.uuid)
  to service_role;
