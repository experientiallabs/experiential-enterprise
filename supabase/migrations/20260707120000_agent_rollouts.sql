-- Playground v2: agent-vs-world-model rollouts.
--
-- A `wm_rollouts` row records one agent rollout against a world model (or a
-- counterfactual fork of an earlier rollout via `parent_rollout_id` +
-- `fork_turn_index`); `wm_rollout_turns` holds the alternating agent/env
-- transcript (`content` is a wmh Action dump for agent turns and an
-- Observation dump for env turns). RLS mirrors the wm_sessions policies:
-- the service role writes, org members read.

create type public.wm_rollout_status as enum (
  'running',
  'completed',
  'failed',
  'max_steps'
);

create type public.wm_rollout_turn_role as enum (
  'agent',
  'env'
);

create table public.wm_rollouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  world_model_id uuid not null references public.world_models(id) on delete cascade,
  -- Agent-model catalog id (see explabs.engine.agent_catalog), not a raw
  -- provider model id.
  agent_model text not null,
  task text not null,
  status public.wm_rollout_status not null default 'running',
  -- Deleting a rollout deletes its fork subtree. SET NULL cannot work here:
  -- it nulls only this column, so the both-or-neither CHECK below would
  -- reject the referential update and make parents with forks undeletable.
  parent_rollout_id uuid references public.wm_rollouts(id) on delete cascade,
  fork_turn_index integer check (fork_turn_index is null or fork_turn_index >= 0),
  max_steps integer not null check (max_steps > 0),
  -- Per-rollout token and cost accounting. Totals cover only the LLM work a
  -- rollout itself caused: live agent completions plus the simulator steps
  -- they triggered. A fork's copied prefix turns keep their usage payloads
  -- for display, but that spend belongs to the PARENT rollout and is never
  -- re-counted here. `cost_usd` is null when the agent model has no verified
  -- list price (the platform reports null rather than a guessed cost).
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  error text,
  created_at timestamptz not null default now(),
  -- Forks carry both pointers or neither.
  check ((parent_rollout_id is null) = (fork_turn_index is null))
);

create index wm_rollouts_world_model_created_idx
  on public.wm_rollouts (world_model_id, created_at desc);

create index wm_rollouts_project_status_idx
  on public.wm_rollouts (project_id, status);

create index wm_rollouts_org_id_idx
  on public.wm_rollouts (org_id);

create index wm_rollouts_parent_rollout_idx
  on public.wm_rollouts (parent_rollout_id);

create table public.wm_rollout_turns (
  id uuid primary key default gen_random_uuid(),
  rollout_id uuid not null references public.wm_rollouts(id) on delete cascade,
  turn_index integer not null check (turn_index >= 0),
  role public.wm_rollout_turn_role not null,
  content jsonb not null,
  usage jsonb,
  created_at timestamptz not null default now(),
  unique (rollout_id, turn_index)
);

alter table public.wm_rollouts enable row level security;
alter table public.wm_rollout_turns enable row level security;

create policy wm_rollouts_select_member
  on public.wm_rollouts
  for select
  to authenticated
  using (org_id in (select public.member_org_ids()));

-- wm_rollout_turns carries no org_id; it reaches its organization through
-- its rollout. The membership subquery stays uncorrelated so it still runs
-- once per statement.
create policy wm_rollout_turns_select_member
  on public.wm_rollout_turns
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.wm_rollouts rollouts
      where rollouts.id = wm_rollout_turns.rollout_id
        and rollouts.org_id in (select public.member_org_ids())
    )
  );
