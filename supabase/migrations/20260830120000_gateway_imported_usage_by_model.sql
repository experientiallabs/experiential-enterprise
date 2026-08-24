-- Imported-usage rollup for the Logs / Telemetry "Imported" panel.
--
-- Sibling of gateway_usage_by_key / gateway_usage_by_provider: one
-- service-role RPC returns the compact per-(source, model) aggregation so the
-- store never pages every gateway_imported_usage_events row through PostgREST.
-- A staging org with ~330k imported turns was making ~330 serial HTTP reads
-- and preventing the server-rendered Logs page from completing.
--
-- Semantics match GatewayImportedUsageStore.by_model / ImportedModelRollup:
--   * model is the catalog alias when model_matched and alias is present,
--     otherwise the raw log string (coalesced to '').
--   * request_count is the number of imported turns in the group.
--   * token and estimated_cost_micro_usd columns sum, null-as-zero.
--   * order is deterministic: highest attributed spend, then highest
--     request_count, then source, model, matched.

create function public.gateway_imported_usage_by_model(
  in_org pg_catalog.uuid
)
returns table (
  import_source pg_catalog.text,
  model pg_catalog.text,
  model_matched pg_catalog.bool,
  request_count pg_catalog.int8,
  input_tokens pg_catalog.int8,
  output_tokens pg_catalog.int8,
  cached_input_tokens pg_catalog.int8,
  reasoning_tokens pg_catalog.int8,
  estimated_cost_micro_usd pg_catalog.int8
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    events.import_source,
    case
      when events.model_matched and events.alias is not null
        then events.alias
      else coalesce(events.model_raw, '')
    end as model,
    events.model_matched,
    pg_catalog.count(*)::pg_catalog.int8 as request_count,
    coalesce(pg_catalog.sum(events.input_tokens), 0)::pg_catalog.int8
      as input_tokens,
    coalesce(pg_catalog.sum(events.output_tokens), 0)::pg_catalog.int8
      as output_tokens,
    coalesce(pg_catalog.sum(events.cached_input_tokens), 0)::pg_catalog.int8
      as cached_input_tokens,
    coalesce(pg_catalog.sum(events.reasoning_tokens), 0)::pg_catalog.int8
      as reasoning_tokens,
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0)::pg_catalog.int8
      as estimated_cost_micro_usd
  from public.gateway_imported_usage_events events
  where events.org_id = in_org
  group by
    events.import_source,
    case
      when events.model_matched and events.alias is not null
        then events.alias
      else coalesce(events.model_raw, '')
    end,
    events.model_matched
  order by
    coalesce(pg_catalog.sum(events.estimated_cost_micro_usd), 0) desc,
    pg_catalog.count(*) desc,
    events.import_source,
    2,
    events.model_matched desc;
end;
$$;

comment on function public.gateway_imported_usage_by_model(pg_catalog.uuid) is
  'Logs imported-usage rollup: one row per (source, model) for an org. model is the catalog alias when matched, else the raw log string. Ordered by attributed spend, then request count. SECURITY DEFINER, service_role-executable.';

revoke all on function public.gateway_imported_usage_by_model(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.gateway_imported_usage_by_model(pg_catalog.uuid)
  to service_role;
