-- Per-model request-modifying config on an endpoint (the Config tab's
-- Reasoning section): {"<pool entry name>": {"reasoning_effort": "high"}}.
-- Keyed by the pool entry's stable handle, NOT stored inside `policy` --
-- candidate-set edits re-dump the policy through wmo's RoutingPolicy, which
-- silently drops keys it does not declare. The default keeps every existing
-- row serving exactly as today (no effort override anywhere).

alter table public.endpoints
  add column model_params jsonb not null default '{}'::jsonb;

alter table public.endpoints
  add constraint endpoints_model_params_size
    check (pg_column_size(model_params) <= 16384);
