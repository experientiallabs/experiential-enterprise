-- Telemetry projection layer for the Telemetry tab.
--
-- Every transcript-shaped artifact the platform stores — live agent session
-- events, playground rollout turns, world-model serving steps, uploaded OTel
-- trace bundles — lands in one org-scoped, trigram-searchable read model:
-- telemetry_spans. telemetry_span_sets groups spans into comparable units
-- (one uploaded trace, one optimizer run, one GEPA-optimized build); a span
-- set is a span set regardless of which producer made it, so new producers
-- add rows, not schema.
--
-- The sources of truth stay where they are and this table stays rebuildable.
-- Sources that already exist as rows project through AFTER INSERT triggers
-- (covering every writer, including the SQL RPC write paths) plus the
-- backfill at the bottom of this file. Uploaded OTel bundles have no row
-- form anywhere — explabs parses those and inserts spans directly
-- (explabs/engine/telemetry_ingest.py), which is why the span mappers below
-- only cover the three row-backed sources.
--
-- Reads go through two service-role RPCs (search_telemetry_spans,
-- list_telemetry_groups) because filtered search needs trigram ILIKE and
-- aggregation that PostgREST query building cannot express, and result sets
-- must stay under the PostgREST max-rows cap.

create extension if not exists pg_trgm with schema extensions;

-- Span sets first: telemetry_spans.span_set_id references them.
create table public.telemetry_span_sets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- 'trace' (one OTel trace in an upload), 'opt_run' (one agent optimization
  -- run), 'gepa_build' (one GEPA-budgeted world-model build). New producers
  -- introduce new kinds without schema changes.
  kind text not null check (kind in ('trace', 'opt_run', 'gepa_build')),
  label text not null,
  -- Producer row this set derives from (trace_uploads / agent_opt_runs /
  -- build_jobs id). Polymorphic on purpose: cleanup triggers on the producer
  -- tables stand in for a foreign key.
  source_ref uuid,
  -- Disambiguates sets sharing a producer row (the OTel traceId within an
  -- upload). Null for one-set-per-producer kinds.
  external_key text,
  -- Reserved for producers that emit per-iteration sets; null until a
  -- producer records iteration granularity.
  iteration_index integer check (iteration_index is null or iteration_index >= 0),
  metrics jsonb,
  created_at timestamptz not null default now(),
  constraint telemetry_span_sets_identity
    unique nulls not distinct (org_id, kind, source_ref, external_key)
);

create index telemetry_span_sets_org_created_idx
  on public.telemetry_span_sets (org_id, created_at desc);

alter table public.telemetry_span_sets enable row level security;

create policy telemetry_span_sets_select_member
  on public.telemetry_span_sets
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

create table public.telemetry_spans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source text not null check (
    source in ('agent_session', 'wm_session', 'rollout', 'trace_upload')
  ),
  -- Parent row id (agent_sessions / wm_sessions / wm_rollouts /
  -- trace_uploads). Polymorphic; delete triggers on the parents clean up.
  source_ref uuid not null,
  span_set_id uuid references public.telemetry_span_sets(id) on delete set null,
  -- Filter denormalizations, resolved at projection time: the agent behind a
  -- session and the world model behind serving, rollouts, and uploads.
  agent_id uuid references public.agents(id) on delete set null,
  world_model_id uuid references public.world_models(id) on delete set null,
  -- OTel identity, only for trace_upload spans.
  trace_id text,
  external_span_id text,
  external_parent_id text,
  -- Ordering within source_ref: event seq, turn_index, step_index, or the
  -- span's ordinal within its upload.
  seq bigint not null check (seq >= 0),
  kind text not null check (
    kind in ('message', 'tool_call', 'tool_result', 'submit', 'error')
  ),
  role text not null check (role in ('user', 'assistant', 'env', 'system')),
  -- Tool name for tool_call/tool_result spans.
  name text,
  input jsonb,
  output jsonb,
  -- Normalized chain-of-thought, whichever channel it arrived through.
  reasoning text,
  model text,
  status text not null default 'ok' check (status in ('ok', 'error')),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  started_at timestamptz not null default now(),
  attributes jsonb,
  -- Extracted plain text for trigram search; mappers cap it so one giant
  -- payload cannot bloat the GIN index.
  search_text text not null default '',
  created_at timestamptz not null default now()
);

-- Idempotency key for trigger + backfill double-coverage and re-ingest.
create unique index telemetry_spans_source_seq_key
  on public.telemetry_spans (source, source_ref, seq);

create index telemetry_spans_org_started_idx
  on public.telemetry_spans (org_id, started_at desc, seq desc);

create index telemetry_spans_org_source_started_idx
  on public.telemetry_spans (org_id, source, started_at desc);

create index telemetry_spans_span_set_idx
  on public.telemetry_spans (span_set_id)
  where span_set_id is not null;

create index telemetry_spans_org_agent_idx
  on public.telemetry_spans (org_id, agent_id)
  where agent_id is not null;

create index telemetry_spans_org_world_model_idx
  on public.telemetry_spans (org_id, world_model_id)
  where world_model_id is not null;

-- Trigram index accelerating the ILIKE search in search_telemetry_spans.
-- The operator class is schema-qualified because migrations run with the
-- default search_path, where the extensions schema is not visible.
create index telemetry_spans_search_trgm_idx
  on public.telemetry_spans
  using gin (search_text extensions.gin_trgm_ops);

alter table public.telemetry_spans enable row level security;

create policy telemetry_spans_select_member
  on public.telemetry_spans
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- ---------------------------------------------------------------------------
-- Span mappers: one function per row-backed source, shared verbatim by the
-- projection triggers and the backfill so the two can never diverge. Each
-- returns zero rows for events that do not belong in telemetry (streaming
-- tool_output chunks, lifecycle state/status events, sessions without an
-- org).
-- ---------------------------------------------------------------------------

create or replace function public.telemetry_rows_from_session_event(
  ev public.agent_session_events
)
returns setof public.telemetry_spans
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent public.agent_sessions;
begin
  -- tool_output rows are streamed chunks of the tool_result that follows;
  -- state/status/workspace_patch are session lifecycle, not transcript.
  if ev.kind not in (
    'user_message', 'assistant_message', 'tool_call', 'tool_result',
    'submit', 'error'
  ) then
    return;
  end if;
  select * into parent from public.agent_sessions where id = ev.session_id;
  if parent.id is null or parent.org_id is null then
    return;
  end if;
  return query
  select
    gen_random_uuid(),
    parent.org_id,
    'agent_session',
    ev.session_id,
    null::uuid,
    parent.agent_id,
    (select agents.world_model_id from public.agents where agents.id = parent.agent_id),
    null::text,
    null::text,
    null::text,
    ev.seq,
    case ev.kind
      when 'user_message' then 'message'
      when 'assistant_message' then 'message'
      when 'submit' then 'submit'
      when 'error' then 'error'
      else ev.kind
    end,
    case ev.kind
      when 'user_message' then 'user'
      when 'tool_result' then 'env'
      when 'error' then 'system'
      else 'assistant'
    end,
    ev.payload ->> 'name',
    case
      when ev.kind = 'tool_call'
        then jsonb_build_object('arguments', ev.payload -> 'arguments')
      else null
    end,
    case ev.kind
      when 'user_message' then jsonb_build_object('text', ev.payload ->> 'text')
      when 'assistant_message' then jsonb_build_object('text', ev.payload ->> 'text')
      when 'submit' then jsonb_build_object('text', ev.payload ->> 'answer')
      when 'error' then jsonb_build_object('text', ev.payload ->> 'message')
      when 'tool_result' then jsonb_build_object(
        'content', ev.payload ->> 'content',
        'is_error', coalesce((ev.payload ->> 'is_error')::boolean, false),
        'truncated', coalesce((ev.payload ->> 'truncated')::boolean, false)
      )
      else null
    end,
    null::text,
    parent.agent_model,
    case
      when ev.kind = 'error'
        or coalesce((ev.payload ->> 'is_error')::boolean, false)
        then 'error'
      else 'ok'
    end,
    null::integer,
    ev.ts,
    jsonb_strip_nulls(jsonb_build_object(
      'event_kind', ev.kind,
      'call_id', ev.payload ->> 'call_id'
    )),
    left(concat_ws(' ',
      ev.payload ->> 'name',
      ev.payload ->> 'text',
      ev.payload ->> 'answer',
      ev.payload ->> 'message',
      ev.payload ->> 'content',
      ev.payload -> 'arguments'
    ), 10000),
    now();
end;
$$;

create or replace function public.telemetry_rows_from_rollout_turn(
  turn public.wm_rollout_turns
)
returns setof public.telemetry_spans
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent public.wm_rollouts;
  set_id uuid;
  turn_is_error boolean;
begin
  select * into parent from public.wm_rollouts where id = turn.rollout_id;
  if parent.id is null then
    return;
  end if;
  if parent.agent_opt_run_id is not null then
    select sets.id into set_id
      from public.telemetry_span_sets sets
     where sets.kind = 'opt_run'
       and sets.source_ref = parent.agent_opt_run_id
       and sets.org_id = parent.org_id;
  end if;
  turn_is_error := coalesce((turn.content ->> 'is_error')::boolean, false);
  return query
  select
    gen_random_uuid(),
    parent.org_id,
    'rollout',
    turn.rollout_id,
    set_id,
    null::uuid,
    parent.world_model_id,
    null::text,
    null::text,
    null::text,
    turn.turn_index::bigint,
    case
      when turn.role = 'env' then 'tool_result'
      when turn.content ->> 'kind' = 'message' then 'message'
      else 'tool_call'
    end,
    case when turn.role = 'env' then 'env' else 'assistant' end,
    turn.content ->> 'name',
    case
      when turn.role = 'agent' and turn.content ->> 'kind' = 'tool_call'
        then jsonb_build_object('arguments', turn.content -> 'arguments')
      else null
    end,
    case
      when turn.role = 'env' then jsonb_build_object(
        'content', turn.content ->> 'content',
        'is_error', turn_is_error,
        'reward', turn.content -> 'reward'
      )
      when turn.content ->> 'kind' = 'message'
        then jsonb_build_object('text', turn.content ->> 'content')
      else null
    end,
    turn.content ->> 'reasoning',
    parent.agent_model,
    case when turn_is_error then 'error' else 'ok' end,
    null::integer,
    turn.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'usage', turn.usage,
      'metadata', turn.content -> 'metadata',
      'is_optimization', to_jsonb(parent.is_optimization)
    )),
    left(concat_ws(' ',
      turn.content ->> 'name',
      turn.content ->> 'content',
      turn.content ->> 'reasoning',
      turn.content -> 'arguments'
    ), 10000),
    now();
end;
$$;

create or replace function public.telemetry_rows_from_wm_step(
  step public.wm_steps
)
returns setof public.telemetry_spans
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent public.wm_sessions;
  step_is_error boolean;
begin
  select * into parent from public.wm_sessions where id = step.wm_session_id;
  if parent.id is null then
    return;
  end if;
  step_is_error := coalesce((step.observation ->> 'is_error')::boolean, false);
  return query
  select
    gen_random_uuid(),
    parent.org_id,
    'wm_session',
    step.wm_session_id,
    null::uuid,
    null::uuid,
    parent.world_model_id,
    null::text,
    null::text,
    null::text,
    step.step_index::bigint,
    case
      when step.action ->> 'kind' = 'message' then 'message'
      else 'tool_call'
    end,
    'assistant',
    step.action ->> 'name',
    case
      when step.action ->> 'kind' = 'message'
        then jsonb_build_object('text', step.action ->> 'content')
      else jsonb_build_object('arguments', step.action -> 'arguments')
    end,
    jsonb_build_object(
      'content', step.observation ->> 'content',
      'is_error', step_is_error,
      'reward', step.observation -> 'reward'
    ),
    null::text,
    null::text,
    case when step_is_error then 'error' else 'ok' end,
    step.latency_ms,
    step.created_at,
    jsonb_strip_nulls(jsonb_build_object(
      'metadata', step.observation -> 'metadata'
    )),
    left(concat_ws(' ',
      step.action ->> 'name',
      step.action ->> 'content',
      step.action -> 'arguments',
      step.observation ->> 'content'
    ), 10000),
    now();
end;
$$;

revoke all on function public.telemetry_rows_from_session_event(public.agent_session_events)
  from public, anon, authenticated;
revoke all on function public.telemetry_rows_from_rollout_turn(public.wm_rollout_turns)
  from public, anon, authenticated;
revoke all on function public.telemetry_rows_from_wm_step(public.wm_steps)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Projection triggers.
-- ---------------------------------------------------------------------------

create or replace function public.project_session_event_telemetry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.telemetry_spans
  select mapped.* from public.telemetry_rows_from_session_event(new) mapped
  on conflict (source, source_ref, seq) do nothing;
  return null;
end;
$$;

create trigger agent_session_events_project_telemetry
after insert on public.agent_session_events
for each row execute function public.project_session_event_telemetry();

create or replace function public.project_rollout_turn_telemetry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.telemetry_spans
  select mapped.* from public.telemetry_rows_from_rollout_turn(new) mapped
  on conflict (source, source_ref, seq) do nothing;
  return null;
end;
$$;

create trigger wm_rollout_turns_project_telemetry
after insert on public.wm_rollout_turns
for each row execute function public.project_rollout_turn_telemetry();

create or replace function public.project_wm_step_telemetry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.telemetry_spans
  select mapped.* from public.telemetry_rows_from_wm_step(new) mapped
  on conflict (source, source_ref, seq) do nothing;
  return null;
end;
$$;

create trigger wm_steps_project_telemetry
after insert on public.wm_steps
for each row execute function public.project_wm_step_telemetry();

revoke all on function public.project_session_event_telemetry()
  from public, anon, authenticated;
revoke all on function public.project_rollout_turn_telemetry()
  from public, anon, authenticated;
revoke all on function public.project_wm_step_telemetry()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Span-set producers. One set per optimizer run and per GEPA-budgeted build;
-- the upsert keeps metrics current as progress lands. Trace sets are created
-- by explabs at OTel ingest time, not here.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_opt_run_span_set()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    return null;
  end if;
  insert into public.telemetry_span_sets (org_id, kind, label, source_ref, metrics)
  values (
    new.org_id,
    'opt_run',
    coalesce(
      (select 'Optimization · ' || agents.name
         from public.agents
        where agents.id = new.agent_id),
      'Optimization run'
    ),
    new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'status', new.status::text,
      'iterations_total', to_jsonb(new.iterations),
      'iterations', new.progress -> 'iterations',
      'result', new.result
    ))
  )
  on conflict on constraint telemetry_span_sets_identity
  do update set metrics = excluded.metrics, label = excluded.label;
  return null;
end;
$$;

create trigger agent_opt_runs_upsert_span_set
after insert or update on public.agent_opt_runs
for each row execute function public.upsert_opt_run_span_set();

create or replace function public.upsert_gepa_build_span_set()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only GEPA-budgeted builds run the optimize phase; plain builds are not
  -- an iteration-shaped grouping.
  if new.org_id is null or new.gepa_budget is null then
    return null;
  end if;
  insert into public.telemetry_span_sets (org_id, kind, label, source_ref, metrics)
  values (
    new.org_id,
    'gepa_build',
    coalesce(
      (select 'GEPA build · ' || world_models.name
         from public.world_models
        where world_models.id = new.world_model_id),
      'GEPA build'
    ),
    new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'status', new.status::text,
      'gepa_budget', to_jsonb(new.gepa_budget),
      'progress', new.progress
    ))
  )
  on conflict on constraint telemetry_span_sets_identity
  do update set metrics = excluded.metrics, label = excluded.label;
  return null;
end;
$$;

create trigger build_jobs_upsert_span_set
after insert or update on public.build_jobs
for each row execute function public.upsert_gepa_build_span_set();

revoke all on function public.upsert_opt_run_span_set()
  from public, anon, authenticated;
revoke all on function public.upsert_gepa_build_span_set()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sibling cloning: uploads are projected by explabs (SQL cannot parse the
-- bundle bytes), but the platform routinely clones the SAME bytes into new
-- rows — starter examples provisioned at signup, catalog imports, the seeded
-- demo pool. Identical bytes mean an identical projection, so a new upload
-- whose sha256 matches an already-projected sibling copies that sibling's
-- spans and trace sets immediately instead of waiting for a backfill.
-- ---------------------------------------------------------------------------

create or replace function public.clone_trace_upload_telemetry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sibling_id uuid;
begin
  if new.sha256 is null then
    return null;
  end if;
  select uploads.id into sibling_id
    from public.trace_uploads uploads
   where uploads.sha256 = new.sha256
     and uploads.id <> new.id
     and exists (
       select 1
         from public.telemetry_spans spans
        where spans.source = 'trace_upload'
          and spans.source_ref = uploads.id
     )
   limit 1;
  if sibling_id is null then
    return null;
  end if;
  insert into public.telemetry_span_sets
    (org_id, kind, label, source_ref, external_key, iteration_index, metrics)
  select new.org_id, sets.kind, sets.label, new.id, sets.external_key,
         sets.iteration_index, sets.metrics
    from public.telemetry_span_sets sets
   where sets.kind = 'trace'
     and sets.source_ref = sibling_id
  on conflict on constraint telemetry_span_sets_identity do nothing;
  insert into public.telemetry_spans
    (org_id, source, source_ref, span_set_id, agent_id, world_model_id,
     trace_id, external_span_id, external_parent_id, seq, kind, role, name,
     input, output, reasoning, model, status, latency_ms, started_at,
     attributes, search_text)
  select new.org_id, 'trace_upload', new.id, new_sets.id, null,
         new.world_model_id, spans.trace_id, spans.external_span_id,
         spans.external_parent_id, spans.seq, spans.kind, spans.role,
         spans.name, spans.input, spans.output, spans.reasoning, spans.model,
         spans.status, spans.latency_ms, spans.started_at, spans.attributes,
         spans.search_text
    from public.telemetry_spans spans
    left join public.telemetry_span_sets old_sets
      on old_sets.id = spans.span_set_id
    left join public.telemetry_span_sets new_sets
      on new_sets.org_id = new.org_id
     and new_sets.kind = 'trace'
     and new_sets.source_ref = new.id
     and new_sets.external_key = old_sets.external_key
   where spans.source = 'trace_upload'
     and spans.source_ref = sibling_id
  on conflict (source, source_ref, seq) do nothing;
  return null;
end;
$$;

create trigger trace_uploads_clone_telemetry
after insert on public.trace_uploads
for each row execute function public.clone_trace_upload_telemetry();

revoke all on function public.clone_trace_upload_telemetry()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cleanup triggers: spans and sets are polymorphic projections with no FK to
-- their producers, so deletes propagate here instead.
-- ---------------------------------------------------------------------------

create or replace function public.delete_telemetry_spans_for_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.telemetry_spans
   where source = tg_argv[0]
     and source_ref = old.id;
  return null;
end;
$$;

create or replace function public.delete_telemetry_sets_for_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.telemetry_span_sets
   where kind = tg_argv[0]
     and source_ref = old.id;
  return null;
end;
$$;

create trigger agent_sessions_delete_telemetry
after delete on public.agent_sessions
for each row execute function public.delete_telemetry_spans_for_source('agent_session');

create trigger wm_rollouts_delete_telemetry
after delete on public.wm_rollouts
for each row execute function public.delete_telemetry_spans_for_source('rollout');

create trigger wm_sessions_delete_telemetry
after delete on public.wm_sessions
for each row execute function public.delete_telemetry_spans_for_source('wm_session');

create trigger trace_uploads_delete_telemetry
after delete on public.trace_uploads
for each row execute function public.delete_telemetry_spans_for_source('trace_upload');

create trigger trace_uploads_delete_telemetry_sets
after delete on public.trace_uploads
for each row execute function public.delete_telemetry_sets_for_source('trace');

create trigger agent_opt_runs_delete_telemetry_sets
after delete on public.agent_opt_runs
for each row execute function public.delete_telemetry_sets_for_source('opt_run');

create trigger build_jobs_delete_telemetry_sets
after delete on public.build_jobs
for each row execute function public.delete_telemetry_sets_for_source('gepa_build');

revoke all on function public.delete_telemetry_spans_for_source()
  from public, anon, authenticated;
revoke all on function public.delete_telemetry_sets_for_source()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read RPCs. Service-role only: the API enforces org membership before
-- calling, like the platform's other control-plane functions. Both exist
-- because trigram ILIKE and grouped aggregation cannot be expressed through
-- PostgREST query building, and unaggregated reads would truncate at the
-- max-rows cap.
-- ---------------------------------------------------------------------------

create or replace function public.search_telemetry_spans(
  in_org uuid,
  in_query text default null,
  in_sources text[] default null,
  in_kinds text[] default null,
  in_status text default null,
  in_has_reasoning boolean default null,
  in_source_ref uuid default null,
  in_span_set uuid default null,
  in_after timestamptz default null,
  in_before timestamptz default null,
  in_limit integer default 100,
  in_offset integer default 0,
  in_agent uuid default null,
  in_world_model uuid default null
)
returns setof public.telemetry_spans
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pattern text := case
    when in_query is null or btrim(in_query) = '' then null
    else '%' || replace(replace(replace(
      btrim(in_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  end;
  cap integer := least(greatest(coalesce(in_limit, 100), 1), 500);
begin
  return query
  select spans.*
    from public.telemetry_spans spans
   where spans.org_id = in_org
     and (in_sources is null or spans.source = any (in_sources))
     and (in_kinds is null or spans.kind = any (in_kinds))
     and (in_status is null or spans.status = in_status)
     and (
       in_has_reasoning is null
       or (spans.reasoning is not null) = in_has_reasoning
     )
     and (in_source_ref is null or spans.source_ref = in_source_ref)
     and (in_span_set is null or spans.span_set_id = in_span_set)
     and (in_agent is null or spans.agent_id = in_agent)
     and (in_world_model is null or spans.world_model_id = in_world_model)
     and (in_after is null or spans.started_at >= in_after)
     and (in_before is null or spans.started_at < in_before)
     and (pattern is null or spans.search_text ilike pattern)
   order by
     -- Transcript fetches (scoped to one source_ref or set) read in event
     -- order, keeping each producer's spans contiguous (a span set can span
     -- many rollouts that each restart seq at 0); browsing reads newest
     -- first.
     case
       when in_source_ref is not null or in_span_set is not null
         then spans.source_ref
     end asc,
     case
       when in_source_ref is not null or in_span_set is not null
         then spans.seq
     end asc,
     spans.started_at desc,
     spans.seq desc
   limit cap
  offset greatest(coalesce(in_offset, 0), 0);
end;
$$;

revoke all on function public.search_telemetry_spans(
  uuid, text, text[], text[], text, boolean, uuid, uuid, timestamptz,
  timestamptz, integer, integer, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.search_telemetry_spans(
  uuid, text, text[], text[], text, boolean, uuid, uuid, timestamptz,
  timestamptz, integer, integer, uuid, uuid
) to service_role;

create or replace function public.list_telemetry_groups(
  in_org uuid,
  in_sources text[] default null,
  in_query text default null,
  in_after timestamptz default null,
  in_before timestamptz default null,
  in_limit integer default 50,
  in_offset integer default 0,
  in_agent uuid default null,
  in_world_model uuid default null
)
returns table (
  source text,
  source_ref uuid,
  label text,
  model text,
  span_count bigint,
  error_count bigint,
  reasoning_count bigint,
  first_at timestamptz,
  last_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pattern text := case
    when in_query is null or btrim(in_query) = '' then null
    else '%' || replace(replace(replace(
      btrim(in_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  end;
  cap integer := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  return query
  -- Materialize the producers with a text hit once, up front: a correlated
  -- EXISTS in the outer where-clause would re-run the trigram lookup for
  -- every span rather than once per group.
  with matching as (
    select distinct hits.source, hits.source_ref
      from public.telemetry_spans hits
     where pattern is not null
       and hits.org_id = in_org
       and hits.search_text ilike pattern
  )
  select
    spans.source,
    spans.source_ref,
    coalesce(
      max(agent_sessions.title),
      max(wm_rollouts.task),
      max(wm_sessions.task),
      max(trace_uploads.filename),
      max(spans.name),
      spans.source
    ),
    max(spans.model),
    count(*),
    count(*) filter (where spans.status = 'error'),
    count(*) filter (where spans.reasoning is not null),
    min(spans.started_at),
    max(spans.started_at)
    from public.telemetry_spans spans
    left join public.agent_sessions
      on spans.source = 'agent_session' and agent_sessions.id = spans.source_ref
    left join public.wm_rollouts
      on spans.source = 'rollout' and wm_rollouts.id = spans.source_ref
    left join public.wm_sessions
      on spans.source = 'wm_session' and wm_sessions.id = spans.source_ref
    left join public.trace_uploads
      on spans.source = 'trace_upload' and trace_uploads.id = spans.source_ref
   where spans.org_id = in_org
     and (in_sources is null or spans.source = any (in_sources))
     and (in_agent is null or spans.agent_id = in_agent)
     and (in_world_model is null or spans.world_model_id = in_world_model)
     and (in_after is null or spans.started_at >= in_after)
     and (in_before is null or spans.started_at < in_before)
     and (
       pattern is null
       or (spans.source, spans.source_ref) in (
         select matching.source, matching.source_ref from matching
       )
     )
   group by spans.source, spans.source_ref
   order by max(spans.started_at) desc
   limit cap
  offset greatest(coalesce(in_offset, 0), 0);
end;
$$;

revoke all on function public.list_telemetry_groups(
  uuid, text[], text, timestamptz, timestamptz, integer, integer, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.list_telemetry_groups(
  uuid, text[], text, timestamptz, timestamptz, integer, integer, uuid, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill. Sets before spans so the rollout mapper can attach optimizer
-- membership; on conflict do nothing keeps every statement idempotent.
-- ---------------------------------------------------------------------------

insert into public.telemetry_span_sets (org_id, kind, label, source_ref, metrics)
select
  runs.org_id,
  'opt_run',
  coalesce('Optimization · ' || agents.name, 'Optimization run'),
  runs.id,
  jsonb_strip_nulls(jsonb_build_object(
    'status', runs.status::text,
    'iterations_total', to_jsonb(runs.iterations),
    'iterations', runs.progress -> 'iterations',
    'result', runs.result
  ))
  from public.agent_opt_runs runs
  left join public.agents on agents.id = runs.agent_id
 where runs.org_id is not null
on conflict on constraint telemetry_span_sets_identity do nothing;

insert into public.telemetry_span_sets (org_id, kind, label, source_ref, metrics)
select
  jobs.org_id,
  'gepa_build',
  coalesce('GEPA build · ' || world_models.name, 'GEPA build'),
  jobs.id,
  jsonb_strip_nulls(jsonb_build_object(
    'status', jobs.status::text,
    'gepa_budget', to_jsonb(jobs.gepa_budget),
    'progress', jobs.progress
  ))
  from public.build_jobs jobs
  left join public.world_models on world_models.id = jobs.world_model_id
 where jobs.org_id is not null
   and jobs.gepa_budget is not null
on conflict on constraint telemetry_span_sets_identity do nothing;

insert into public.telemetry_spans
select mapped.*
  from public.agent_session_events events
 cross join lateral public.telemetry_rows_from_session_event(events) mapped
on conflict (source, source_ref, seq) do nothing;

insert into public.telemetry_spans
select mapped.*
  from public.wm_rollout_turns turns
 cross join lateral public.telemetry_rows_from_rollout_turn(turns) mapped
on conflict (source, source_ref, seq) do nothing;

insert into public.telemetry_spans
select mapped.*
  from public.wm_steps steps
 cross join lateral public.telemetry_rows_from_wm_step(steps) mapped
on conflict (source, source_ref, seq) do nothing;
