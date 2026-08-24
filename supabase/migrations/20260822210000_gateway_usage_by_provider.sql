-- Gateway usage by provider: the Telemetry page's "By platform" rollup.
-- Sibling of gateway_usage_by_key (20260819233500_gateway_usage_reads.sql)
-- with the same read semantics: request_count counts every finished request
-- (errors included), error_count is the non-completed subset, money stays
-- integer micro-USD with the charged/estimated split intact.
--
-- provider is the winning attempt's provider, denormalized onto the event at
-- settlement; a null provider means nothing was dispatched (the request died
-- before any provider call), and those rows group under null so the API can
-- label them honestly instead of dropping them.

create function public.gateway_usage_by_provider(
  in_org pg_catalog.uuid,
  in_after pg_catalog.timestamptz default null
)
returns table (
  provider pg_catalog.text,
  request_count pg_catalog.int8,
  error_count pg_catalog.int8,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cost_micro_usd pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8,
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
    events.provider,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    (pg_catalog.count(*) filter (where events.status <> 'completed')
      )::pg_catalog.int8 as error_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as input_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as output_tokens,
    coalesce(pg_catalog.sum(events.cost_micro_usd), 0)::pg_catalog.int8
      as cost_micro_usd,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd,
    pg_catalog.max(events.created_at) as last_used_at
  from public.gateway_usage_events events
  where events.org_id = in_org
    and (in_after is null or events.created_at >= in_after)
  group by events.provider
  -- Provider cardinality is single digits, but keep the by-key rollup's
  -- deterministic bound anyway rather than trusting PostgREST truncation.
  order by pg_catalog.count(*) desc, events.provider
  limit 1000;
end;
$$;

revoke all on function public.gateway_usage_by_provider(
  pg_catalog.uuid, pg_catalog.timestamptz
) from public, anon, authenticated;
grant execute on function public.gateway_usage_by_provider(
  pg_catalog.uuid, pg_catalog.timestamptz
) to service_role;
