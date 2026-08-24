-- Capture the world-model (env) side of playground rollouts. A rollout pays
-- for two models: the agent's completions (already persisted as
-- input_tokens/output_tokens/cost_usd) and the world-model serve calls that
-- simulate the environment, which were metered in the engine but never
-- persisted. `wm_cost_usd` follows the same contract as every other cost
-- column: null when the serve model has no verified list price.
--
-- No backfill: the env-side usage of past rollouts was never captured, so
-- existing rows keep 0 tokens and a null cost ("not recorded"), which the
-- rollups already treat as no data rather than unpriced traffic.

alter table public.wm_rollouts
  add column wm_input_tokens bigint not null default 0 check (wm_input_tokens >= 0),
  add column wm_output_tokens bigint not null default 0 check (wm_output_tokens >= 0),
  add column wm_cost_usd numeric(12, 6) check (wm_cost_usd is null or wm_cost_usd >= 0);

comment on column public.wm_rollouts.wm_cost_usd is
  'Estimated world-model (env) serve spend in USD from verified list prices; null when the serve model has no verified price.';
