-- Persist full agent-completion diagnostics for failed playground rollouts.
--
-- `wm_rollouts.error` remains the short human-facing failure summary surfaced
-- in streams and list/detail views. `failure_detail` keeps structured
-- debugging payloads such as full raw agent replies and provider finish
-- reasons, which are too large/noisy for the status error string.

alter table public.wm_rollouts
  add column failure_detail jsonb;
