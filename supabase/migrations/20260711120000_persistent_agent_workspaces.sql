-- One durable E2B filesystem per hosted agent. Live sessions resume this
-- sandbox and pause it filesystem-only between runs, so files survive while
-- runner processes and open connections do not.

alter table public.agents
  add column workspace_sandbox_id text;

comment on column public.agents.workspace_sandbox_id is
  'Stable E2B sandbox id for the agent workspace, paused filesystem-only between live sessions.';

-- Agent deletion uses the existing durable external-cleanup outbox. Store the
-- exact E2B ids beside Storage objects so a transient E2B outage cannot leak a
-- paused workspace after the relational cascade commits.
alter table public.storage_cleanup_jobs
  add column sandbox_ids text[] not null default '{}';
