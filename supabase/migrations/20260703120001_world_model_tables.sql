-- Experiential Labs world-model platform schema, part 2 of 3: world models,
-- trace uploads, build jobs, and serving sessions/steps.
--
-- World models are built from customer OTel trace uploads by the in-process
-- world-model-harness (wmh) and served as stateful sessions. Built bundles
-- are canonical in Supabase Storage: `world_models.artifact_id` points at the
-- public.artifacts metadata row describing the current bundle, and
-- EXPLABS_WMH_ROOT is only a host-local cache of unpacked bundles.

create type public.world_model_status as enum (
  'created',
  'building',
  'ready',
  'failed'
);

-- Build worker lifecycle (a worker claiming and draining one build job).
create type public.build_job_status as enum (
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'stalled'
);

create type public.wm_session_status as enum (
  'active',
  'expired',
  'closed'
);

create table public.world_models (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- wmh model slug; doubles as the on-disk directory name under
  -- $EXPLABS_WMH_ROOT/models/, so it must stay filesystem- and URL-safe.
  name text not null check (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  display_name text,
  status public.world_model_status not null default 'created',
  serve_provider text,
  serve_model text,
  embed_provider text,
  embed_dim integer check (embed_dim is null or embed_dim > 0),
  gepa_budget integer check (gepa_budget is null or gepa_budget > 0),
  trace_adapter text not null default 'otel-genai',
  config jsonb not null default '{}'::jsonb,
  -- Current built bundle; storage is canonical, this is the metadata link.
  artifact_id uuid references public.artifacts(id) on delete set null,
  metrics jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create trigger world_models_set_updated_at
before update on public.world_models
for each row execute function public.set_updated_at();

create index world_models_project_status_idx
  on public.world_models (project_id, status);

create index world_models_org_id_idx
  on public.world_models (org_id);

-- public.artifacts is created in part 1, before world_models exists; now that
-- both tables are present, link every built bundle back to its world model.
alter table public.artifacts
  add column world_model_id uuid references public.world_models(id) on delete set null;

create index artifacts_world_model_id_idx
  on public.artifacts (world_model_id);

-- Raw OTel trace bundles uploaded by tenants. Bytes live in object storage at
-- `storage_path`; `world_model_id` is null until the upload is bound to a
-- model build.
create table public.trace_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  world_model_id uuid references public.world_models(id) on delete set null,
  filename text not null,
  storage_path text not null,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  sha256 text,
  adapter text not null default 'otel-genai',
  trace_count integer check (trace_count is null or trace_count >= 0),
  step_count integer check (step_count is null or step_count >= 0),
  status text not null default 'uploaded' check (status in ('uploaded', 'ingested', 'failed')),
  created_at timestamptz not null default now()
);

create index trace_uploads_project_created_idx
  on public.trace_uploads (project_id, created_at desc);

create index trace_uploads_world_model_id_idx
  on public.trace_uploads (world_model_id);

-- Covering index for the org cascade FK.
create index trace_uploads_org_id_idx
  on public.trace_uploads (org_id);

-- Long-running GEPA build jobs dispatched to workers; progress is polled via
-- `progress` and liveness via `heartbeat_at`.
create table public.build_jobs (
  id uuid primary key default gen_random_uuid(),
  world_model_id uuid not null references public.world_models(id) on delete cascade,
  trace_upload_id uuid not null references public.trace_uploads(id) on delete cascade,
  -- Post-build held-out fidelity evaluation toggle: every build replays the final
  -- serving prompt open-loop over the held-out trace split (wmh's eval scorer) so a
  -- real fidelity number is reported even with GEPA off. On by default; a build
  -- request can opt a single job out.
  evaluate boolean not null default true,
  status public.build_job_status not null default 'queued',
  gepa_budget integer check (gepa_budget is null or gepa_budget > 0),
  runtime_backend text,
  runtime_call_id text,
  worker_id text,
  heartbeat_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  usage jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index build_jobs_status_created_idx
  on public.build_jobs (status, created_at);

create index build_jobs_world_model_created_idx
  on public.build_jobs (world_model_id, created_at desc);

-- Covering index for the trace-upload cascade FK.
create index build_jobs_trace_upload_id_idx
  on public.build_jobs (trace_upload_id);

-- Stateful serving sessions against a ready world model. `wmh_session_id` is
-- the harness-side identifier for the in-process session state.
create table public.wm_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  world_model_id uuid not null references public.world_models(id) on delete cascade,
  wmh_session_id text,
  task text,
  seed_state jsonb,
  status public.wm_session_status not null default 'active',
  step_count integer not null default 0 check (step_count >= 0),
  usage jsonb,
  created_at timestamptz not null default now(),
  last_step_at timestamptz
);

create index wm_sessions_world_model_created_idx
  on public.wm_sessions (world_model_id, created_at desc);

create index wm_sessions_project_status_idx
  on public.wm_sessions (project_id, status);

-- Covering index for the org cascade FK.
create index wm_sessions_org_id_idx
  on public.wm_sessions (org_id);

-- Action -> observation pairs within a session, ordered by step_index.
create table public.wm_steps (
  id uuid primary key default gen_random_uuid(),
  wm_session_id uuid not null references public.wm_sessions(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  action jsonb not null,
  observation jsonb not null,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  unique (wm_session_id, step_index)
);

-- Atomically claim a session's next step slot and append the step row.
--
-- The claim UPDATE (active-status guard + dense step_index check + counter
-- bump + optional usage replacement) and the wm_steps INSERT must commit
-- together: separate PostgREST calls run in separate transactions, so a
-- claim that commits without its step row would strand the session with
-- `step_count` pointing past the transcript, and every later dense-index
-- claim would lose. Returns the inserted step row; returns zero rows when
-- the claim loses (missing or non-active session, or a non-dense
-- step_index) so the caller can diagnose and fail loudly.
create or replace function public.record_wm_step(
  in_session_id uuid,
  in_step_index integer,
  in_action jsonb,
  in_observation jsonb,
  in_latency_ms integer default null,
  in_usage jsonb default null
)
returns setof public.wm_steps
language sql
set search_path = ''
as $$
  with claimed as (
    update public.wm_sessions
       set step_count = in_step_index + 1,
           last_step_at = now(),
           usage = coalesce(in_usage, wm_sessions.usage)
     where wm_sessions.id = in_session_id
       and wm_sessions.step_count = in_step_index
       and wm_sessions.status = 'active'::public.wm_session_status
     returning wm_sessions.id
  )
  insert into public.wm_steps (wm_session_id, step_index, action, observation, latency_ms)
  select in_session_id, in_step_index, in_action, in_observation, in_latency_ms
    from claimed
  returning wm_steps.*;
$$;

-- Only the service role records steps; strip Supabase's default EXECUTE
-- grants (PUBLIC/anon/authenticated) like the other control-plane functions.
revoke all on function public.record_wm_step(uuid, integer, jsonb, jsonb, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_wm_step(uuid, integer, jsonb, jsonb, integer, jsonb)
  to service_role;
