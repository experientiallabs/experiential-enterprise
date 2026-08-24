-- Project insights reads: the simulation link and attributable serving traffic.
--
-- Two changes back the restored model-page panels:
--
-- 1. `optimizer_projects.world_model_id` mirrors the retired
--    `endpoints.world_model_id` link: one Project optimizes against one
--    simulation, and the Dataset/Scenarios tabs read the retained
--    world-model corpus and mined scenario sets through it. `on delete set
--    null` keeps Project rows standing when a simulation is wiped, exactly
--    as endpoints did.
--
-- 2. `settle_optimizer_project_serving_interaction` now records WHICH model
--    served each request. The row's `model` column previously stayed null on
--    the Project lane, which collapsed the restored "where your traffic
--    goes" panel into one unattributed bucket for all new traffic. The
--    gateway passes the selected candidate's customer-declared model id; a
--    pre-selection failure settles with null, which reads as unattributed.

alter table public.optimizer_projects
  add column world_model_id pg_catalog.uuid
    references public.world_models(id) on delete set null;

comment on column public.optimizer_projects.world_model_id is
  'The simulation this Project optimizes against; null until linked.';

-- The Project branch of the serving-request shape forbade `model`; it is now
-- the recorded routing attribution, so the constraint re-states everything
-- else unchanged and drops only that line.
alter table public.serving_requests
  drop constraint serving_requests_optimizer_project_shape;
alter table public.serving_requests
  add constraint serving_requests_optimizer_project_shape check (
    (
      optimizer_project_id is null
      and server_interaction_id is null
      and active_router_job_id is null
      and active_router_generation is null
      and settlement_sha256 is null
      and optimizer_project_billing_source is null
      and optimizer_project_billing_breakdown is null
    )
    or (
      optimizer_project_id is not null
      and server_interaction_id is not null
      and active_router_job_id is not null
      and active_router_generation > 0
      and settlement_sha256 ~ '^[0-9a-f]{64}$'
      and provider_model is null
      and cluster_id is null
      and cluster_label is null
      and routing_reason is null
      and router_cost_usd is null
      and provider_connection_id is null
      and (
        (status = 'ok' and error_message is null)
        or (
          status = 'error'
          and error_message in (
            'invalid_request', 'model_capability_invalid', 'provider_failed',
            'outcome_ambiguous', 'service_unavailable', 'internal_failure',
            'model_paused', 'credits_exhausted',
            'spend_limit_exceeded', 'token_limit_exceeded'
          )
        )
      )
      and pg_catalog.jsonb_typeof(optimizer_project_billing_breakdown) = 'object'
      and optimizer_project_billing_breakdown ?& array[
        'router_embedding', 'selected_candidate'
      ]::pg_catalog.text[]
      and optimizer_project_billing_breakdown - array[
        'router_embedding', 'selected_candidate'
      ]::pg_catalog.text[] = '{}'::pg_catalog.jsonb
      and optimizer_project_billing_breakdown ->> 'router_embedding'
        in ('host_managed', 'customer_managed', 'not_applicable')
      and optimizer_project_billing_breakdown ->> 'selected_candidate'
        in ('host_managed', 'customer_managed', 'not_applicable')
      and (
        (
          optimizer_project_billing_source = 'host_managed'
          and byok = false
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            in ('host_managed', 'not_applicable')
          and optimizer_project_billing_breakdown ->> 'selected_candidate'
            in ('host_managed', 'not_applicable')
          and (
            optimizer_project_billing_breakdown ->> 'router_embedding'
              = 'host_managed'
            or optimizer_project_billing_breakdown ->> 'selected_candidate'
              = 'host_managed'
          )
        )
        or (
          optimizer_project_billing_source = 'customer_managed'
          and byok = true
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            in ('customer_managed', 'not_applicable')
          and optimizer_project_billing_breakdown ->> 'selected_candidate'
            in ('customer_managed', 'not_applicable')
          and (
            optimizer_project_billing_breakdown ->> 'router_embedding'
              = 'customer_managed'
            or optimizer_project_billing_breakdown ->> 'selected_candidate'
              = 'customer_managed'
          )
        )
        or (
          optimizer_project_billing_source = 'mixed'
          and byok = false
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            <> optimizer_project_billing_breakdown ->> 'selected_candidate'
          and (
            optimizer_project_billing_breakdown ->> 'router_embedding'
              in ('host_managed', 'customer_managed')
            or optimizer_project_billing_breakdown ->> 'selected_candidate'
              in ('host_managed', 'customer_managed')
          )
        )
        or (
          optimizer_project_billing_source = 'none'
          and byok = false
          and optimizer_project_billing_breakdown ->> 'router_embedding'
            = 'not_applicable'
          and optimizer_project_billing_breakdown ->> 'selected_candidate'
            = 'not_applicable'
        )
      )
    )
  );

-- The settle function gains `p_model`. The old 8-argument signature must go
-- away entirely (PostgREST would otherwise see an ambiguous overload set).
drop function public.settle_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text
);

create function public.settle_optimizer_project_serving_interaction(
  p_server_interaction_id pg_catalog.uuid,
  p_request pg_catalog.jsonb,
  p_response pg_catalog.jsonb,
  p_latency_ms pg_catalog.int4,
  p_ttfb_ms pg_catalog.int4,
  p_components pg_catalog.jsonb,
  p_status pg_catalog.text,
  p_error_code pg_catalog.text,
  p_model pg_catalog.text default null
)
returns setof public.serving_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interaction public.optimizer_project_serving_interactions%rowtype;
  v_project public.optimizer_projects%rowtype;
  v_existing public.serving_requests%rowtype;
  v_request public.serving_requests%rowtype;
  v_component pg_catalog.jsonb;
  v_usage pg_catalog.jsonb;
  v_payload pg_catalog.jsonb;
  v_sha pg_catalog.text;
  v_total_cost pg_catalog.numeric(20, 6);
  v_host_cost pg_catalog.numeric(20, 6);
  v_host_components pg_catalog.int2;
  v_customer_components pg_catalog.int2;
  v_billing_source pg_catalog.text;
  v_billing_breakdown pg_catalog.jsonb;
  v_input_tokens pg_catalog.int8;
  v_output_tokens pg_catalog.int8;
  v_cached_tokens pg_catalog.int8;
begin
  perform public.optimizer_project_wmo_require_service_role();
  if p_server_interaction_id is null
     or p_latency_ms < 0 or p_ttfb_ms < 0
     or p_request is not null and pg_catalog.jsonb_typeof(p_request) <> 'object'
     or p_response is not null and pg_catalog.jsonb_typeof(p_response) <> 'object'
     or p_components is null
     or pg_catalog.jsonb_typeof(p_components) <> 'array'
     or pg_catalog.jsonb_array_length(p_components) <> 2
     or p_status not in ('ok', 'error')
     or (p_status = 'ok' and p_error_code is not null)
     or pg_catalog.length(p_model) > 200
     or (
       p_status = 'error'
       and (
         p_error_code is null
         or p_error_code not in (
           'invalid_request', 'model_capability_invalid', 'provider_failed',
           'outcome_ambiguous', 'service_unavailable', 'internal_failure',
           'model_paused', 'credits_exhausted',
           'spend_limit_exceeded', 'token_limit_exceeded'
         )
       )
     ) then
    raise exception 'invalid Project serving settlement shape' using errcode = '22023';
  end if;

  -- `p_model` stays OUT of the replay digest on purpose: it is derived
  -- attribution metadata (the components already fix the economics), and a
  -- retry that straddles this migration must still converge on its row.
  v_payload := pg_catalog.jsonb_build_object(
    'request', p_request,
    'response', p_response,
    'latency_ms', p_latency_ms,
    'ttfb_ms', p_ttfb_ms,
    'components', p_components,
    'status', p_status,
    'error_code', p_error_code
  );
  v_sha := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_payload::pg_catalog.text, 'UTF8')
    ),
    'hex'
  );
  select requests.* into v_existing
  from public.serving_requests as requests
  where requests.server_interaction_id = p_server_interaction_id;
  if v_existing.id is not null then
    if v_existing.settlement_sha256 <> v_sha then
      raise exception 'Project serving settlement replay drifted' using errcode = '23505';
    end if;
    return query select * from public.serving_requests
      where id = v_existing.id;
    return;
  end if;

  select interactions.* into v_interaction
  from public.optimizer_project_serving_interactions as interactions
  where interactions.server_interaction_id = p_server_interaction_id
    and interactions.state in ('admitted', 'dispatch_reserved')
  for update;
  if v_interaction.server_interaction_id is null then
    raise exception 'Project serving interaction was not admitted' using errcode = 'P0002';
  end if;
  select projects.* into v_project
  from public.optimizer_projects as projects
  where projects.id = v_interaction.project_id;
  if v_project.id is null then
    raise exception 'Project serving interaction lost its Project' using errcode = '23514';
  end if;

  for v_component in
    select value from pg_catalog.jsonb_array_elements(p_components)
  loop
    if pg_catalog.jsonb_typeof(v_component) <> 'object'
       or v_component - array[
         'operation_id', 'operation_ordinal', 'component', 'billing_source',
         'disposition', 'operation_count', 'usage', 'cost_usd',
         'cost_provenance', 'provider_connection_id',
         'provider_connection_revision'
       ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
       or not v_component ?& array[
         'operation_id', 'operation_ordinal', 'component', 'billing_source',
         'disposition', 'operation_count', 'usage', 'cost_usd',
         'cost_provenance'
       ]::pg_catalog.text[] then
      raise exception 'Project serving component has an unsupported shape'
        using errcode = '22023';
    end if;
    v_usage := v_component -> 'usage';
    if pg_catalog.jsonb_typeof(v_usage) <> 'object'
       or not v_usage ?& array['input_tokens', 'output_tokens']::pg_catalog.text[]
       or v_usage - array[
         'input_tokens', 'output_tokens', 'cached_input_tokens',
         'cache_write_input_tokens'
       ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
       or (v_usage ->> 'input_tokens')::pg_catalog.int8 < 0
       or (v_usage ->> 'output_tokens')::pg_catalog.int8 < 0
       or coalesce((v_usage ->> 'cached_input_tokens')::pg_catalog.int8, 0) < 0
       or coalesce((v_usage ->> 'cache_write_input_tokens')::pg_catalog.int8, 0) < 0
       or coalesce((v_usage ->> 'cached_input_tokens')::pg_catalog.int8, 0)
          > (v_usage ->> 'input_tokens')::pg_catalog.int8
       or coalesce((v_usage ->> 'cache_write_input_tokens')::pg_catalog.int8, 0)
          > (v_usage ->> 'input_tokens')::pg_catalog.int8 then
      raise exception 'Project serving component usage is invalid' using errcode = '22023';
    end if;
    if v_component ->> 'component' not in ('router_embedding', 'selected_candidate')
       or (v_component ->> 'operation_ordinal')::pg_catalog.int2 not in (1, 2)
       or (
         (v_component ->> 'component' = 'router_embedding'
          and (v_component ->> 'operation_ordinal')::pg_catalog.int2 <> 1)
         or (v_component ->> 'component' = 'selected_candidate'
          and (v_component ->> 'operation_ordinal')::pg_catalog.int2 <> 2)
       )
       or v_component ->> 'billing_source' not in (
         'host_managed', 'customer_managed', 'not_applicable'
       )
       or v_component ->> 'disposition' not in (
         'observed', 'locally_priced', 'reserved_ambiguous',
         'definitely_not_incurred'
       )
       or (v_component ->> 'operation_count')::pg_catalog.int2 not in (0, 1)
       or (v_component ->> 'cost_usd')::pg_catalog.numeric < 0
       or (v_component ->> 'cost_usd')::pg_catalog.numeric
          <> pg_catalog.round((v_component ->> 'cost_usd')::pg_catalog.numeric, 6)
       or (v_component ->> 'cost_usd')::pg_catalog.numeric
          > 99999999999999.999999
       or v_component ->> 'cost_provenance' not in ('observed', 'estimated') then
      raise exception 'Project serving component accounting is invalid'
        using errcode = '22023';
    end if;
    if v_component ->> 'billing_source' = 'not_applicable' then
      if v_component ->> 'disposition' <> 'definitely_not_incurred'
         or nullif(v_component ->> 'provider_connection_id', '') is not null
         or nullif(v_component ->> 'provider_connection_revision', '') is not null then
        raise exception 'not-applicable component must prove no provider operation'
          using errcode = '22023';
      end if;
    elsif v_component ->> 'billing_source' = 'host_managed' then
      if nullif(v_component ->> 'provider_connection_id', '') is not null
         or nullif(v_component ->> 'provider_connection_revision', '') is not null then
        raise exception 'host-managed component cannot name a customer connection'
          using errcode = '22023';
      end if;
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        v_interaction.connection_revisions
      ) as revisions(value)
      where (revisions.value ->> 'provider_connection_id')::pg_catalog.uuid
          = (v_component ->> 'provider_connection_id')::pg_catalog.uuid
        and (revisions.value ->> 'serving_revision')::pg_catalog.int8
          = (v_component ->> 'provider_connection_revision')::pg_catalog.int8
    ) then
      raise exception 'customer-managed component is outside its admitted connection set'
        using errcode = '42501';
    end if;
  end loop;

  if (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'component' = 'router_embedding'
      and (components.value ->> 'operation_ordinal')::pg_catalog.int2 = 1
  ) <> 1 or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'component' = 'selected_candidate'
      and (components.value ->> 'operation_ordinal')::pg_catalog.int2 = 2
  ) <> 1 then
    raise exception 'Project serving settlement requires exactly two components'
      using errcode = '23514';
  end if;

  select
    pg_catalog.sum((components.value ->> 'cost_usd')::pg_catalog.numeric),
    pg_catalog.sum((components.value ->> 'cost_usd')::pg_catalog.numeric)
      filter (where components.value ->> 'billing_source' = 'host_managed'),
    pg_catalog.count(*) filter (
      where components.value ->> 'billing_source' = 'host_managed'
    ),
    pg_catalog.count(*) filter (
      where components.value ->> 'billing_source' = 'customer_managed'
    ),
    pg_catalog.max(
      (components.value -> 'usage' ->> 'input_tokens')::pg_catalog.int8
    ) filter (where components.value ->> 'component' = 'selected_candidate'),
    pg_catalog.max(
      (components.value -> 'usage' ->> 'output_tokens')::pg_catalog.int8
    ) filter (where components.value ->> 'component' = 'selected_candidate'),
    pg_catalog.max(coalesce(
      (components.value -> 'usage' ->> 'cached_input_tokens')::pg_catalog.int8, 0
    )) filter (where components.value ->> 'component' = 'selected_candidate')
    into v_total_cost, v_host_cost, v_host_components, v_customer_components,
         v_input_tokens, v_output_tokens, v_cached_tokens
  from pg_catalog.jsonb_array_elements(p_components) as components(value);
  v_host_cost := coalesce(v_host_cost, 0);
  v_billing_source := case
    when v_host_components = 0 and v_customer_components = 0 then 'none'
    when v_customer_components = 0 then 'host_managed'
    when v_host_components = 0 then 'customer_managed'
    else 'mixed'
  end;
  select pg_catalog.jsonb_object_agg(
    components.value ->> 'component',
    components.value ->> 'billing_source'
  ) into v_billing_breakdown
  from pg_catalog.jsonb_array_elements(p_components) as components(value);

  insert into public.serving_requests (
    org_id, endpoint_id, endpoint_label, api_key_id, byok,
    model,
    input_tokens, output_tokens, cached_tokens, cost_usd,
    latency_ms, ttfb_ms, status, error_message, request, response,
    optimizer_project_id, server_interaction_id,
    active_router_job_id, active_router_generation, settlement_sha256,
    optimizer_project_billing_source, optimizer_project_billing_breakdown
  ) values (
    v_interaction.org_id, v_interaction.project_id, v_project.slug,
    v_interaction.api_key_id, v_billing_source = 'customer_managed',
    nullif(p_model, ''),
    v_input_tokens, v_output_tokens, v_cached_tokens, v_total_cost,
    p_latency_ms, p_ttfb_ms, p_status, p_error_code,
    case when v_interaction.store_bodies then p_request else null end,
    case when v_interaction.store_bodies then p_response else null end,
    v_interaction.project_id, p_server_interaction_id,
    v_interaction.job_id, v_interaction.generation, v_sha,
    v_billing_source, v_billing_breakdown
  ) returning * into v_request;

  insert into public.optimizer_project_serving_components (
    serving_request_id, operation_id, operation_ordinal, component,
    billing_source, disposition, operation_count, usage, cost_usd,
    cost_provenance, provider_connection_id, provider_connection_revision
  )
  select
    v_request.id,
    components.value ->> 'operation_id',
    (components.value ->> 'operation_ordinal')::pg_catalog.int2,
    components.value ->> 'component',
    components.value ->> 'billing_source',
    components.value ->> 'disposition',
    (components.value ->> 'operation_count')::pg_catalog.int2,
    components.value -> 'usage',
    (components.value ->> 'cost_usd')::pg_catalog.numeric,
    components.value ->> 'cost_provenance',
    nullif(components.value ->> 'provider_connection_id', '')::pg_catalog.uuid,
    nullif(components.value ->> 'provider_connection_revision', '')::pg_catalog.int8
  from pg_catalog.jsonb_array_elements(p_components) as components(value)
  order by (components.value ->> 'operation_ordinal')::pg_catalog.int2;

  update public.organizations
  set spend_usd = spend_usd + v_total_cost,
      billable_spend_usd = billable_spend_usd + v_host_cost
  where id = v_interaction.org_id;
  update public.provider_connections as connections
  set metered_spend_usd = connections.metered_spend_usd + totals.cost_usd
  from (
    select (components.value ->> 'provider_connection_id')::pg_catalog.uuid as id,
           pg_catalog.sum(
             (components.value ->> 'cost_usd')::pg_catalog.numeric
           ) as cost_usd
    from pg_catalog.jsonb_array_elements(p_components) as components(value)
    where components.value ->> 'billing_source' = 'customer_managed'
    group by (components.value ->> 'provider_connection_id')::pg_catalog.uuid
  ) as totals
  where connections.id = totals.id;

  delete from public.optimizer_project_serving_interactions
  where server_interaction_id = p_server_interaction_id;
  return query select * from public.serving_requests where id = v_request.id;
end;
$$;

revoke all on function public.settle_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.settle_optimizer_project_serving_interaction(
  pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb,
  pg_catalog.int4, pg_catalog.int4, pg_catalog.jsonb,
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) to service_role;
