-- Scenario sets: the eval-scenario artifact mined from a world model's trace corpus at
-- build time (wmh's scenarios pipeline: facets -> cluster -> select -> synthesize ->
-- checklist back-agreement). One row per build job that mined; the newest row per world
-- model is its live eval set -- the GENERATE output the routing optimizer evaluates
-- candidate models against, pinned so evidence like "N held-out scenarios" cites a
-- fixed set.
create table public.world_model_scenario_sets (
  id uuid primary key default gen_random_uuid(),
  world_model_id uuid not null references public.world_models(id) on delete cascade,
  build_job_id uuid not null references public.build_jobs(id) on delete cascade,
  -- wmh ScenarioSet dump: scenarios (scenario_id, task, seed_state, checklist,
  -- provenance trace ids, cluster_name, weight, source_outcome), named clusters, and
  -- the corpus stats that justify the selection.
  payload jsonb not null,
  scenario_count integer not null check (scenario_count >= 0),
  -- Selection honesty (the Bench-GEN lessons): how many scenarios were budgeted vs
  -- survived, and the minted set's source-outcome tally (success/failure/unknown) so a
  -- corpus-inverting selection is visible instead of silent.
  budget integer not null check (budget > 0),
  dropped_count integer not null check (dropped_count >= 0),
  outcome_mix jsonb not null,
  corpus_traces integer not null,
  corpus_coverage double precision not null,
  coverage_tau double precision not null,
  -- Provenance: the LLM that mined (facets/naming/synthesis/validation share it).
  provider text not null,
  model text not null,
  created_at timestamptz not null default now()
);

create index world_model_scenario_sets_wm_created_idx
  on public.world_model_scenario_sets (world_model_id, created_at desc);
