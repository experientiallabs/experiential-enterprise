-- Agent task maps: the 2D embedding of the task descriptions Clio-style
-- scenario mining clustered for a run's suite (wmh scenarios). The worker
-- records it with the mined suite (facet embed texts — domain + task
-- summary + tool signature — -> vectors captured during the build -> a
-- UMAP-style spectral layout onto the unit square); the agent page renders
-- it as a fixed-size scatter.
-- Each point's `task` is the facet's task summary. Shape:
--   {points:   [{trace_id, task, x, y, cluster_id, mined, task_id}],
--    clusters: [{cluster_id, name, size}]}
-- Null until the worker mines the suite (and for runs recorded before this
-- column existed). RLS is unchanged: agent_opt_runs policies already cover
-- the new column.

alter table public.agent_opt_runs
  add column task_map jsonb;
