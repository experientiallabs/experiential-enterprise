-- Routing optimization as a job the platform runs itself, so a hosted endpoint can
-- improve without anyone fitting a policy on a laptop and pushing it.
--
-- Endpoint-scoped, which is why this is not a `build_jobs` row: a build produces a
-- world model, this produces a POLICY for one endpoint of one, and the two have
-- different owners and different failure meanings (a failed fit leaves a perfectly
-- servable endpoint alone; a failed build can leave a model unusable).
--
-- The status enum is reused deliberately. A stalled optimize job and a stalled build
-- are the same operational condition and the runs panel already reads that vocabulary,
-- so inventing a parallel set of names would give the same state two spellings.
--
-- SPEND IS ON THE ROW, not just in a config file. The sweep this job runs measures
-- every candidate model on the endpoint's scenarios, which is the only genuinely
-- expensive thing the platform does on a customer's behalf outside a build. A cap
-- that lived only in the caller's request would be unauditable after the fact, so
-- the authorized ceiling and what was actually spent are both persisted: the
-- question "who authorized this bill" has to be answerable from the row.

create table public.routing_optimize_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  endpoint_id uuid not null references public.endpoints(id) on delete cascade,
  status public.build_job_status not null default 'queued',
  worker_id text,
  -- Same heartbeat contract as build_jobs: a live worker touches this, and a reader
  -- calls the job stalled from staleness rather than the worker declaring it. A
  -- heartbeat must never become a kill signal (the tau grid runner's rule).
  heartbeat_at timestamptz,
  -- {stage, done, total, scenarios, models} while the sweep runs, so the runs panel
  -- can show cell-level progress instead of a spinner.
  progress jsonb not null default '{}'::jsonb,
  -- The ceiling the caller authorized, in USD. Null means "no explicit cap", which
  -- the runner refuses rather than treating as unlimited.
  spend_cap_usd numeric(12, 6),
  -- What the sweep projected before spending, and what it actually spent. Both kept:
  -- a projection that turns out badly wrong is the thing you need to see to fix the
  -- estimator, and it is invisible if only the outcome is stored.
  projected_usd numeric(12, 6),
  spend_usd numeric(12, 6),
  -- The policy this job installed, once it did. Null until then, so a job that
  -- measured and then failed to install is distinguishable from one that installed.
  installed_policy_sha256 text
    check (installed_policy_sha256 ~ '^[0-9a-f]{64}$'),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index routing_optimize_jobs_endpoint_created_idx
  on public.routing_optimize_jobs (endpoint_id, created_at desc);

create index routing_optimize_jobs_status_created_idx
  on public.routing_optimize_jobs (status, created_at);

-- At most one job in flight per endpoint. Two concurrent sweeps on one endpoint would
-- bill twice for the same measurement and race to install, and the loser's policy
-- would silently win or lose depending on commit order. Enforced in the schema rather
-- than by the caller checking first, because that check has a window.
create unique index routing_optimize_jobs_one_active_per_endpoint
  on public.routing_optimize_jobs (endpoint_id)
  where status in ('queued', 'claimed', 'running');

-- Locked down like endpoints and serving_requests: reads go through the service role,
-- which projects a customer-safe view. The progress payload names pool entries and
-- their provider models, which the platform treats as server-internal.
alter table public.routing_optimize_jobs enable row level security;
revoke all on table public.routing_optimize_jobs from public, anon, authenticated;

comment on table public.routing_optimize_jobs is
  'One routing-optimizer run for one endpoint: sweep the candidate pool over the endpoint''s scenarios, fit a policy, install it. Spend cap and actual spend are recorded so an authorized bill is auditable.';

comment on column public.routing_optimize_jobs.spend_cap_usd is
  'USD ceiling the caller authorized for the sweep. The runner refuses to start without one and refuses a plan whose projection exceeds it.';
