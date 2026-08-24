-- Storage object deletion cannot share a transaction with relational cascades.
-- Keep a service-role-only outbox so a successful resource delete always
-- retains the exact bucket/path set until Supabase Storage confirms cleanup.

alter table public.artifacts
  add column agent_opt_run_id uuid
    references public.agent_opt_runs(id) on delete cascade;

update public.artifacts artifacts
set agent_opt_run_id = runs.id
from public.agent_opt_runs runs
where artifacts.kind = 'task_embeddings'
  and artifacts.storage_path = 'agent-runs/' || runs.id::text || '/task-embeddings.json';

alter table public.artifacts
  add constraint artifacts_agent_opt_run_kind_check
  check (agent_opt_run_id is null or kind = 'task_embeddings');

create index artifacts_agent_opt_run_id_idx
  on public.artifacts (agent_opt_run_id);

create table public.storage_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  resource_type text not null check (resource_type in ('world_model', 'agent')),
  resource_id uuid not null,
  state text not null default 'staged' check (state in ('staged', 'pending')),
  objects jsonb not null check (jsonb_typeof(objects) = 'array'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index storage_cleanup_jobs_state_created_idx
  on public.storage_cleanup_jobs (state, created_at);

alter table public.storage_cleanup_jobs enable row level security;

-- No policies: only the service role stages or drains cleanup work.
