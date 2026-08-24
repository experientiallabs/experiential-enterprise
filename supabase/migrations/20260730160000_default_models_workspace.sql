-- The default-models workspace reaches hosted environments (the product owner,
-- 2026-07-30: staging's three real default models - runs, data, and
-- simulations included - transfer into the workspace directly).
--
-- Two things only a migration can do here:
--
-- 1. The workspace org and its curation copy exist so far only in
--    supabase/seed.sql, which hosted environments never run (local docker's
--    migrate-and-seed applies it; the hosting platform deploys run migrations plus
--    `explabs seed-models`). Without this migration, staging and production
--    would have an empty door. The rows mirror seed.sql exactly (same stable
--    ids, both idempotent), and seed.sql keeps its copy so a fresh local
--    stack is complete before the CLI runs.
--
-- 2. Adopting an existing model into the workspace is a MULTI-TABLE move: an
--    endpoint owns runs, serving telemetry, and optimize jobs, and its world
--    model (the simulation) owns artifacts, builds, ingests, uploads, spans,
--    rollouts, and sessions - every org-scoped row must re-home together or
--    tenancy checks orphan the leftovers. That has to be atomic, so it is a
--    database function rather than a sequence of PostgREST updates that can
--    fail halfway. Service-role only, like every control-plane write.

insert into public.organizations (id, slug, name)
values (
  '00000000-0000-0000-0000-000000000003',
  'default-models',
  'Default Models'
)
on conflict (id) do update set
  slug = excluded.slug,
  name = excluded.name;

insert into public.default_models (
  id, slug, title, benchmark, description, tags,
  world_model_slug, catalog_entry_name, headline, display_order
) values
  (
    '00000000-0000-0000-0000-000000000d01',
    'tau-bench',
    'tau-bench',
    'τ²-bench',
    'Multi-turn customer-service tool use: look up a user, book or modify an order, and hold to the domain''s policy across the conversation.',
    '["tool-calls", "customer-service", "multi-turn"]'::jsonb,
    'tau-bench',
    'tau-bench',
    null,
    1
  ),
  (
    '00000000-0000-0000-0000-000000000d02',
    'terminal-bench-2',
    'terminal-bench-2',
    'Terminal-Bench 2.0',
    'Command-line work in a container: inspect a filesystem, run shell commands, and read their output to drive a task to completion.',
    '["terminal", "shell", "containers"]'::jsonb,
    null,
    'terminal-tasks',
    null,
    2
  ),
  (
    '00000000-0000-0000-0000-000000000d03',
    'swe-bench',
    'swe-bench',
    'SWE-bench',
    'Repository-level bug fixing: read the failing test, navigate an unfamiliar codebase, and produce a patch that resolves the issue.',
    '["code", "patching", "repositories"]'::jsonb,
    null,
    'swe-bench',
    null,
    3
  )
on conflict (id) do update set
  slug = excluded.slug,
  title = excluded.title,
  benchmark = excluded.benchmark,
  description = excluded.description,
  tags = excluded.tags,
  world_model_slug = excluded.world_model_slug,
  catalog_entry_name = excluded.catalog_entry_name,
  headline = excluded.headline,
  display_order = excluded.display_order;

-- Re-home one endpoint (and everything it owns) into the default-models
-- workspace. Idempotent: adopting an already-adopted endpoint is a no-op
-- update. Raises on an unknown endpoint so a typo'd id fails loudly instead
-- of "succeeding" over nothing.
create or replace function public.adopt_default_model(p_endpoint_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target constant uuid := '00000000-0000-0000-0000-000000000003';
  v_world_model_id uuid;
begin
  select world_model_id into v_world_model_id
    from public.endpoints where id = p_endpoint_id;
  if not found then
    raise exception 'adopt_default_model: no endpoint with id %', p_endpoint_id;
  end if;

  -- A world model shared with another endpoint cannot move without stranding
  -- that sibling in its org while its simulation leaves. Refuse and let the
  -- operator split or adopt both deliberately; a silent partial move would
  -- surface later as a tenancy hole nobody can trace back here.
  if v_world_model_id is not null and exists (
    select 1 from public.endpoints
    where world_model_id = v_world_model_id and id <> p_endpoint_id
  ) then
    raise exception
      'adopt_default_model: world model % also backs another endpoint; adopt or detach the sibling first',
      v_world_model_id;
  end if;

  update public.endpoints set org_id = v_target where id = p_endpoint_id;
  -- The endpoint's own history: optimizer runs, serving telemetry, jobs.
  update public.runs set org_id = v_target where endpoint_id = p_endpoint_id;
  update public.serving_requests set org_id = v_target where endpoint_id = p_endpoint_id;
  update public.routing_optimize_jobs set org_id = v_target where endpoint_id = p_endpoint_id;

  -- The simulation behind it, with every org-scoped row it owns. Tables
  -- keyed by world_model_id without an org column (scenario sets, suites)
  -- follow their parent and need no update.
  if v_world_model_id is not null then
    update public.world_models set org_id = v_target where id = v_world_model_id;
    update public.runs set org_id = v_target where world_model_id = v_world_model_id;
    update public.artifacts set org_id = v_target where world_model_id = v_world_model_id;
    update public.build_jobs set org_id = v_target where world_model_id = v_world_model_id;
    update public.trace_ingests set org_id = v_target where world_model_id = v_world_model_id;
    update public.trace_uploads set org_id = v_target where world_model_id = v_world_model_id;
    update public.telemetry_spans set org_id = v_target where world_model_id = v_world_model_id;
    update public.wm_rollouts set org_id = v_target where world_model_id = v_world_model_id;
    update public.wm_sessions set org_id = v_target where world_model_id = v_world_model_id;
    update public.agent_cost_reports set org_id = v_target where world_model_id = v_world_model_id;
    update public.agent_opt_runs set org_id = v_target where world_model_id = v_world_model_id;
    update public.agents set org_id = v_target where world_model_id = v_world_model_id;
  end if;
end;
$$;

comment on function public.adopt_default_model(uuid) is
  'Move an endpoint and everything it owns (runs, telemetry, jobs, its world model and that model''s artifacts/builds/ingests/uploads/spans/rollouts/sessions) into the default-models workspace. Service-role only; the CLI wrapper is `explabs adopt-default`.';

-- Control-plane write: the backend (service role) is the only caller. The
-- revoke strips the default PUBLIC execute (which service_role also rides
-- on), so the service-role grant must be explicit.
revoke all on function public.adopt_default_model(uuid) from public, anon, authenticated;
grant execute on function public.adopt_default_model(uuid) to service_role;
