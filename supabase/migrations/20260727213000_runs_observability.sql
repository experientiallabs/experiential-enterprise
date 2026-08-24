-- Runs observability (D-RUNS v1).
--
-- Platform counterpart rows for every wmo run (grid arms, optimize pipelines,
-- builds, research probes): the tables behind the admin pipeline panel and the
-- `wmo runs` CLI. External machines push batched, per-run-sequenced events
-- through the org-key-authed ingest route; the platform persists BEFORE any
-- fan-out, so the SSE tail is a resumable view over run_events, never an
-- in-memory stream.
--
-- Spend columns record the wmo ledger's split and keep its semantics:
-- compressor_usd is a SUBSET of candidate_usd (never a third addend), and the
-- authoritative run total is candidate_usd + wm_usd. Run spend is
-- display-only: it never joins organizations.spend_usd or the metering fold
-- (that meter is customer-billing truth).
--
-- All five tables are locked (RLS on, zero policies, explicit revoke): reads
-- are platform-admin-only through the API, which uses the service role. A
-- normal org user must find nothing enumerable here.

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The emitter's stable name for the run, e.g. "jt/grid-c2/identity" or
  -- "tau-bench/optimize/<manifest-run>". Ingest upserts on (org_id,
  -- external_id) so backfill replays and emitter restarts converge on one row.
  external_id text not null,
  kind text not null check (kind in ('grid_arm', 'pipeline', 'build', 'distill', 'research')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'stopped')),
  benchmark text,
  arm text,
  -- Attachment is optional: a grid run evaluates many pool models and hangs
  -- off the world model it runs against; research probes may attach to
  -- nothing and appear only in the org-level list.
  world_model_id uuid references public.world_models(id) on delete set null,
  endpoint_id uuid references public.endpoints(id) on delete set null,
  -- Cohort/pool/plan snapshot from run.meta. Bounded: config is a summary,
  -- not an artifact dump. Convention: '{}' means "none reported yet" for both
  -- jsonb snapshot columns (documented substitute for null, so the not-null
  -- default keeps reads simple).
  config jsonb not null default '{}'::jsonb check (pg_column_size(config) <= 262144),
  -- Latest heartbeat snapshot: { done, total, scored, stage }.
  progress jsonb not null default '{}'::jsonb check (pg_column_size(progress) <= 16384),
  -- Ledger-split spend snapshot. Null = not yet reported, never a $0 guess.
  candidate_usd numeric check (candidate_usd is null or candidate_usd >= 0),
  compressor_usd numeric check (compressor_usd is null or compressor_usd >= 0),
  wm_usd numeric check (wm_usd is null or wm_usd >= 0),
  -- Last process that fed this run (hostname:pid:uuid8). Several processes
  -- may feed one run (chunked grid arms); this is diagnostic, not identity.
  emitter_id text,
  error text,
  started_at timestamptz not null,
  -- Liveness signal for the read-side wedged badge. Never a kill trigger.
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  -- High-water mark of accepted event seqs; answered to emitters so a
  -- restarted process resumes without replaying the whole file.
  last_seq bigint not null default 0 check (last_seq >= 0),
  -- Emitter timestamp of the newest run-level event applied to this row's
  -- snapshot columns. Seq bands are deliberately not time-ordered across
  -- processes, so ordering guards use the event clock: a replayed or late
  -- lower-seq snapshot older than this is a no-op, which is what lets every
  -- batch re-project all of its events (partial projection failures heal on
  -- the next replay instead of becoming permanent).
  projected_ts timestamptz,
  -- Separate guard clock for run.status events. Status must not share
  -- projected_ts with heartbeats: heartbeats are frequent and almost always
  -- hold the newest clock, so a shared guard would let a heartbeat suppress
  -- the one terminal status that ends the run (and every replay of it).
  status_ts timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index runs_org_external_idx on public.runs (org_id, external_id);

create index runs_org_created_idx on public.runs (org_id, created_at desc, id desc);

-- The admin list's default view is cross-org newest-first; the status filter
-- keyset-pages the same way.
create index runs_created_idx on public.runs (created_at desc, id desc);

create index runs_status_created_idx on public.runs (status, created_at desc, id desc);

-- The per-run event stream: the SSE tail and the audit trail. seq is the
-- EMITTER's number and exists for idempotency (backfill replays the same
-- seqs; the composite pk + ON CONFLICT DO NOTHING makes replay a no-op).
-- Processes feeding one run own disjoint seq ranges, so seq order is NOT
-- arrival order across processes; pos is the server-assigned stream
-- position every cursor read and SSE resume orders by instead. pos is a
-- table-global identity, so per-run values are sparse; it is a cursor, not
-- a count.
create table public.run_events (
  run_id uuid not null references public.runs(id) on delete cascade,
  seq bigint not null check (seq >= 1),
  pos bigint generated always as identity,
  type text not null,
  payload jsonb not null check (pg_column_size(payload) <= 1048576),
  -- Emitter clock; received_at is the platform clock.
  ts timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create index run_events_run_pos_idx on public.run_events (run_id, pos);

-- The spend curve reads one sparse type (ledger.line) out of a large log;
-- without type in the index that is a full per-run walk on every detail load.
create index run_events_run_type_pos_idx on public.run_events (run_id, type, pos);

-- Stage rows mirror the wmo optimize manifest plus grid chunk structure.
-- artifact holds the per-stage SUMMARY the stage views render (matrix
-- top-lines, router cluster geometry, compaction exemplars, routing mix);
-- anything bigger belongs in object storage, not here.
create table public.run_stages (
  run_id uuid not null references public.runs(id) on delete cascade,
  stage text not null,
  status text not null check (status in ('running', 'completed', 'failed', 'skipped')),
  fingerprint jsonb check (fingerprint is null or pg_column_size(fingerprint) <= 65536),
  artifact jsonb check (artifact is null or pg_column_size(artifact) <= 262144),
  candidate_usd numeric check (candidate_usd is null or candidate_usd >= 0),
  compressor_usd numeric check (compressor_usd is null or compressor_usd >= 0),
  wm_usd numeric check (wm_usd is null or wm_usd >= 0),
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  -- Emitter timestamp of the event this row reflects; older events are
  -- discarded instead of regressing a completed stage.
  event_ts timestamptz,
  updated_at timestamptz not null default now(),
  primary key (run_id, stage)
);

-- One row per evaluated cell (scenario x model x episode). Error rows are
-- first-class: an unscored cell keeps reward null and its error text (a 500
-- must never read as incapability). Retries rewrite the row in place.
create table public.run_cells (
  run_id uuid not null references public.runs(id) on delete cascade,
  -- "scenario|model|episode", the wmo sweep's cell identity.
  cell_key text not null,
  chunk integer,
  scenario_id text not null,
  model text not null,
  episode integer not null check (episode >= 0),
  reward double precision,
  success boolean,
  steps integer check (steps is null or steps >= 0),
  stop_reason text,
  error text,
  usage jsonb check (usage is null or pg_column_size(usage) <= 65536),
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  -- call_seconds, compression fields, truncated text previews. The emitter
  -- truncates long text to 4096-char previews BEFORE sending; the check is
  -- the backstop.
  detail jsonb check (detail is null or pg_column_size(detail) <= 262144),
  -- Emitter timestamp of the event this row reflects; a replayed error row
  -- must not overwrite the retry's score that superseded it.
  event_ts timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, cell_key)
);

create index run_cells_run_model_idx on public.run_cells (run_id, model);

-- The unscored/error filter is the panel's main diagnostic view.
create index run_cells_run_unscored_idx on public.run_cells (run_id)
  where reward is null;

-- Admin-issued control requests (stop / retry). Delivery is pull-based: the
-- ingest response carries pending commands and the emitter acks then
-- executes; "rejected" with a note is a legal answer. Wedged detection is
-- computed read-side from heartbeat age and never writes here.
create table public.run_control (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  command text not null check (command in ('stop', 'retry_unscored', 'force_from_stage')),
  args jsonb not null default '{}'::jsonb
    check (pg_column_size(args) <= 65536),
  status text not null default 'pending'
    check (status in ('pending', 'acked', 'done', 'rejected')),
  -- Who asked: an auth.users id when a platform admin pressed the button or an
  -- org member asked from the app, or an api_keys id when the org's own machine
  -- asked over the CLI (a key-authenticated request has no end user). No FK
  -- either way — the column spans two id spaces, and auth.users is another
  -- schema, per house convention. Tenant-facing reads project a derived
  -- "was this staff" boolean instead of the raw value.
  requested_by uuid not null,
  note text,
  created_at timestamptz not null default now(),
  acked_at timestamptz,
  resolved_at timestamptz
);

create index run_control_run_pending_idx on public.run_control (run_id, created_at)
  where status = 'pending';

alter table public.runs enable row level security;
alter table public.run_events enable row level security;
alter table public.run_stages enable row level security;
alter table public.run_cells enable row level security;
alter table public.run_control enable row level security;

-- No PostgREST surface at all: zero policies + explicit revoke. The panel is
-- platform-admin-only and the API reads with the service role; org users must
-- not be able to enumerate that these tables exist.
revoke all on table public.runs from public, anon, authenticated;
revoke all on table public.run_events from public, anon, authenticated;
revoke all on table public.run_stages from public, anon, authenticated;
revoke all on table public.run_cells from public, anon, authenticated;
revoke all on table public.run_control from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read RPCs. Service-role only; the API enforces platform-admin before
-- calling. Single-row and streaming reads are direct service-role selects in
-- the store; these RPCs cover the shapes PostgREST query building cannot
-- express (keyset pagination, aggregation).
-- ---------------------------------------------------------------------------

-- Cross-org, newest-first keyset list behind the admin runs table.
create or replace function public.list_runs(
  in_org uuid default null,
  in_status text default null,
  in_kind text default null,
  in_cursor_ts timestamptz default null,
  in_cursor_id uuid default null,
  in_limit integer default 50
)
returns table (
  id uuid,
  org_id uuid,
  org_name text,
  external_id text,
  kind text,
  status text,
  benchmark text,
  arm text,
  world_model_id uuid,
  endpoint_id uuid,
  progress jsonb,
  candidate_usd numeric,
  compressor_usd numeric,
  wm_usd numeric,
  error text,
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap integer := least(greatest(coalesce(in_limit, 50), 1), 200);
begin
  return query
  select
    runs.id,
    runs.org_id,
    orgs.name,
    runs.external_id,
    runs.kind,
    runs.status,
    runs.benchmark,
    runs.arm,
    runs.world_model_id,
    runs.endpoint_id,
    runs.progress,
    runs.candidate_usd,
    runs.compressor_usd,
    runs.wm_usd,
    runs.error,
    runs.started_at,
    runs.heartbeat_at,
    runs.finished_at,
    runs.created_at
    from public.runs runs
    join public.organizations orgs on orgs.id = runs.org_id
   where (in_org is null or runs.org_id = in_org)
     and (in_status is null or runs.status = in_status)
     and (in_kind is null or runs.kind = in_kind)
     and (
       in_cursor_ts is null
       or in_cursor_id is null
       or (runs.created_at, runs.id) < (in_cursor_ts, in_cursor_id)
     )
   order by runs.created_at desc, runs.id desc
   limit cap;
end;
$$;

revoke all on function public.list_runs(
  uuid, text, text, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_runs(
  uuid, text, text, timestamptz, uuid, integer
) to service_role;

-- Keyset cell list. detail is included: cell rows are already
-- preview-truncated at the emitter, and the per-cell drill-down is the
-- panel's whole point.
create or replace function public.list_run_cells(
  in_run uuid,
  in_model text default null,
  in_scored boolean default null,
  -- Tri-state like in_scored: errored cells are unscored, but an unscored
  -- cell need not have errored (in-flight cells have neither), so the errors
  -- filter cannot be derived from in_scored.
  in_error boolean default null,
  in_cursor_key text default null,
  in_limit integer default 100
)
returns table (
  cell_key text,
  chunk integer,
  scenario_id text,
  model text,
  episode integer,
  reward double precision,
  success boolean,
  steps integer,
  stop_reason text,
  error text,
  usage jsonb,
  cost_usd numeric,
  detail jsonb,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cap integer := least(greatest(coalesce(in_limit, 100), 1), 500);
begin
  return query
  select
    cells.cell_key,
    cells.chunk,
    cells.scenario_id,
    cells.model,
    cells.episode,
    cells.reward,
    cells.success,
    cells.steps,
    cells.stop_reason,
    cells.error,
    cells.usage,
    cells.cost_usd,
    cells.detail,
    cells.updated_at
    from public.run_cells cells
   where cells.run_id = in_run
     and (in_model is null or cells.model = in_model)
     and (
       in_scored is null
       or (in_scored and cells.reward is not null)
       or (not in_scored and cells.reward is null)
     )
     and (
       in_error is null
       or (in_error and cells.error is not null)
       or (not in_error and cells.error is null)
     )
     and (in_cursor_key is null or cells.cell_key > in_cursor_key)
   order by cells.cell_key
   limit cap;
end;
$$;

revoke all on function public.list_run_cells(
  uuid, text, boolean, boolean, text, integer
) from public, anon, authenticated;
grant execute on function public.list_run_cells(
  uuid, text, boolean, boolean, text, integer
) to service_role;

-- Per-model rollup: scored/error counts, spend, reward mean. Drives the
-- routing-mix style breakdown and the spend reconciliation against the run's
-- ledger snapshot (cells sum vs candidate_usd).
create or replace function public.run_cell_stats(
  in_run uuid
)
returns table (
  model text,
  cell_count bigint,
  scored_count bigint,
  error_count bigint,
  -- Rows with no verified price, surfaced so a partial sum never silently
  -- under-reports (house cost honesty rule).
  unpriced_count bigint,
  cost_usd_total numeric,
  reward_mean double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select
    cells.model,
    count(*),
    count(*) filter (where cells.reward is not null),
    count(*) filter (where cells.error is not null),
    count(*) filter (where cells.cost_usd is null),
    sum(cells.cost_usd),
    avg(cells.reward)
    from public.run_cells cells
   where cells.run_id = in_run
   group by cells.model
   order by cells.model;
end;
$$;

revoke all on function public.run_cell_stats(uuid)
  from public, anon, authenticated;
grant execute on function public.run_cell_stats(uuid)
  to service_role;
