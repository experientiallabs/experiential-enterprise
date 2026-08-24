-- Platform-wide gateway usage read for the admin Telemetry section: the same
-- grouped rollup gateway_usage_daily_read answers per org, summed across every
-- organization. The per-org read deliberately hard-filters org_id in every
-- branch; the operator surface needs the complement, so it gets its own
-- function instead of a nullable-org hole in the tenant read. Groupings:
--   day   -> per-day totals across all orgs (the admin time series)
--   model -> per-alias totals ordered by spend (platform top models)
--   org   -> per-org totals ordered by spend (the per-org breakdown table;
--            drilling into one org reuses the tenant read, which platform
--            admins already pass for any org)

-- Cross-org day-window scans have no index today: the rollup's primary key
-- leads with org_id and the only secondary index leads with user_id. Leading
-- with day is safe here, unlike gateway_usage_events (whose cross-org window
-- reads filter on created_at because its day column is the request-clock UTC
-- date): the rollup's day column IS the bucket key, so a day-bounded scan can
-- never miss boundary rows.
create index gateway_usage_daily_day_idx
  on public.gateway_usage_daily (day desc);

create function public.gateway_usage_platform_read(
  in_from pg_catalog.date default null,
  in_to pg_catalog.date default null,
  in_group_by pg_catalog.text default 'day',
  in_limit pg_catalog.int4 default 400
)
returns table (
  day pg_catalog.date,
  org_id pg_catalog.uuid,
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
     where (in_from is null or daily.day >= in_from)
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
     where (in_from is null or daily.day >= in_from)
       and (in_to is null or daily.day <= in_to)
     group by daily.alias
     order by pg_catalog.sum(daily.spend_micro_usd) desc, daily.alias
     limit cap;
  elsif in_group_by = 'org' then
    return query
    select null::pg_catalog.date, daily.org_id, null::pg_catalog.text,
           pg_catalog.sum(daily.requests)::pg_catalog.int8,
           pg_catalog.sum(daily.input_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.output_tokens)::pg_catalog.int8,
           pg_catalog.sum(daily.spend_micro_usd)::pg_catalog.int8
      from public.gateway_usage_daily daily
     where (in_from is null or daily.day >= in_from)
       and (in_to is null or daily.day <= in_to)
     group by daily.org_id
     order by pg_catalog.sum(daily.spend_micro_usd) desc, daily.org_id
     limit cap;
  else
    raise exception using errcode = '22023',
      message = 'invalid platform usage grouping (expected day, model, or org)';
  end if;
end;
$$;

revoke all on function public.gateway_usage_platform_read(
  pg_catalog.date, pg_catalog.date, pg_catalog.text, pg_catalog.int4
) from public, anon, authenticated;
grant execute on function public.gateway_usage_platform_read(
  pg_catalog.date, pg_catalog.date, pg_catalog.text, pg_catalog.int4
) to service_role;
