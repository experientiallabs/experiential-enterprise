-- Per-day-per-model usage rollup for the Overview hero chart: the daily bars
-- now stack by model, so the tenant read gains a fourth grouping.
--
--   day_model -> one row per (day, alias) with traffic in the range, newest
--                day first and biggest spender first within a day, so when a
--                wide range hits the row cap the OLDEST days truncate and the
--                chart's client-side "Other" residual (day totals come from
--                the authoritative group_by=day read) absorbs them instead of
--                the recent days going missing.
--
-- Same signature, filters, metric sums, and cap as 20260819233200; only the
-- grouping vocabulary grows, so this is a re-create of the tenant read. The
-- platform read (gateway_usage_platform_read) is untouched — the admin
-- Telemetry panel keeps its flat per-day series.
create or replace function public.gateway_usage_daily_read(
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
  elsif in_group_by = 'day_model' then
    return query
    select daily.day, null::pg_catalog.uuid, daily.alias,
           pg_catalog.sum(daily.requests)::pg_catalog.int8,
           pg_catalog.sum(daily.input_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.output_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.spend_micro_usd)::pg_catalog.int8
      from public.gateway_usage_daily daily
     where daily.org_id = in_org
       and (in_user is null or daily.user_id = in_user)
       and (in_from is null or daily.day >= in_from)
       and (in_to is null or daily.day <= in_to)
     group by daily.day, daily.alias
     order by daily.day desc, pg_catalog.sum(daily.spend_micro_usd) desc,
              daily.alias
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
      message = 'invalid gateway usage grouping (expected day, day_model, model, or member)';
  end if;
end;
$$;
