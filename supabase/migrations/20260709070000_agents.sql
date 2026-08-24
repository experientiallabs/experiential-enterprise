-- Hosted agents: a named agent harness optimized against a world model.
--
-- An `agents` row is the durable identity of one hosted agent: it names the
-- world model the agent's harness is optimized against, the catalog model
-- that drives the agent LLM, and its search budget. The harness itself lives
-- in `agent_harness_versions`: an append-only lineage of wmh HarnessDocs —
-- v0 is the baseline written at creation, and every optimization delta the
-- gate accepts appends one version (the DB, not worker-local disk, owns the
-- docs; a version renders deterministically to wmh's bundle file layout, so
-- versions can later be packed to object storage and pulled by an execution
-- sandbox). `agents.champion_version` points at the current champion. An
-- `agent_opt_runs` row is the durable record of one harness optimization run
-- (wmh `create_harness` search) dispatched to a worker, mirroring the
-- `build_jobs` lifecycle so a stale worker cannot regress state. RLS mirrors
-- the wm_rollouts policies: the service role writes, org members read.

create type public.agent_status as enum (
  'created',
  'optimizing',
  'ready',
  'failed'
);

create type public.agent_opt_run_status as enum (
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'stalled'
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  world_model_id uuid not null references public.world_models(id) on delete cascade,
  -- wmh harness names double as identifiers inside optimization archives;
  -- keep them slug-safe like world_models.name.
  name text not null check (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  display_name text,
  status public.agent_status not null default 'created',
  -- Agent-model catalog id (see explabs.engine.agent_catalog), not a raw
  -- provider model id: the LLM the harness drives during optimization.
  agent_model text not null,
  -- Optimization search budget, fixed at agent creation: propose-screen-
  -- score-gate iterations per run, and eval passes per task (metrics are
  -- means over k). Runs snapshot these at dispatch.
  iterations integer not null default 5 check (iterations > 0),
  k integer not null default 3 check (k > 0),
  -- Current champion harness: the `agent_harness_versions` row with this
  -- version. Starts at 0 (the creation-time baseline) and advances once per
  -- gate-accepted optimization delta.
  champion_version integer not null default 0 check (champion_version >= 0),
  -- Champion closed-loop success rate on the run's task suite, in [0, 1].
  best_score numeric(5, 4) check (best_score is null or (best_score >= 0 and best_score <= 1)),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create index agents_org_id_idx
  on public.agents (org_id);

create index agents_project_status_idx
  on public.agents (project_id, status);

create index agents_world_model_created_idx
  on public.agents (world_model_id, created_at desc);

create table public.agent_opt_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- Denormalized from the agent (like wm_rollouts.project_id) so the usage
  -- rollup reads a project's runs in one filtered query.
  project_id uuid not null references public.projects(id) on delete cascade,
  status public.agent_opt_run_status not null default 'queued',
  iterations integer not null check (iterations > 0),
  k integer not null check (k > 0),
  -- Task suite driving the search: an array of wmh TaskSpec payloads
  -- ({task_id, instruction, gold}). Null until the worker mines it from the
  -- world model's traces (wmh scenario construction), then recorded here so
  -- every run carries the exact suite it optimized against.
  tasks jsonb,
  runtime_backend text,
  runtime_call_id text,
  worker_id text,
  heartbeat_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  -- Search outcome summary (seed/best scores, screened/skipped counts);
  -- accepted docs land in agent_harness_versions.
  result jsonb,
  -- Per-leg metered usage for the whole run, written at completion:
  -- {worker|judge|world_model: {input_tokens, output_tokens, calls,
  -- cost_usd|null}}. The worker leg prices with the agent-model catalog;
  -- the judge and world-model legs price with the owning model's serve
  -- model (null when unpriced — never a guessed $0).
  usage jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index agent_opt_runs_agent_created_idx
  on public.agent_opt_runs (agent_id, created_at desc);

create index agent_opt_runs_project_idx
  on public.agent_opt_runs (project_id);

create table public.agent_harness_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  -- Append-only lineage: v0 is the baseline harness written at agent
  -- creation; each gate-accepted optimization delta appends the next.
  version integer not null check (version >= 0),
  -- Canonical wmh HarnessDoc of this version.
  doc jsonb not null,
  doc_hash text not null,
  -- Run that produced the version; null for the creation-time baseline.
  run_id uuid references public.agent_opt_runs(id) on delete set null,
  -- Full-suite closed-loop score the search measured for this version, when
  -- it measured one, in [0, 1].
  score numeric(5, 4) check (score is null or (score >= 0 and score <= 1)),
  -- Accepted wmh HarnessDelta audit that produced this version (ops with
  -- per-op rationale + gate verdict); null for the baseline.
  delta jsonb,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);

create index agent_harness_versions_agent_version_idx
  on public.agent_harness_versions (agent_id, version desc);

alter table public.agents enable row level security;
alter table public.agent_opt_runs enable row level security;
alter table public.agent_harness_versions enable row level security;

create policy agents_select_member
  on public.agents
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- agent_opt_runs carries no org_id; it reaches its organization through its
-- agent. The membership subquery stays uncorrelated so it still runs once
-- per statement.
create policy agent_opt_runs_select_member
  on public.agent_opt_runs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.agents agents
      where agents.id = agent_opt_runs.agent_id
        and agents.org_id in (select public.member_org_ids())
    )
  );

-- agent_harness_versions reaches its organization through its agent.
create policy agent_harness_versions_select_member
  on public.agent_harness_versions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.agents agents
      where agents.id = agent_harness_versions.agent_id
        and agents.org_id in (select public.member_org_ids())
    )
  );
