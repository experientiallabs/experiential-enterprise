-- CLI-launched agent sessions still run in the platform's hosted E2B driver,
-- but import a local working-directory snapshot before boot and export the
-- final workspace before the row becomes terminal.

alter table public.agent_sessions
  add column workspace_sync boolean not null default false,
  add column workspace_owner text,
  add constraint agent_sessions_workspace_owner_check check (
    (workspace_sync and workspace_owner is not null)
    or (not workspace_sync and workspace_owner is null)
  );

comment on column public.agent_sessions.workspace_sync is
  'Hosted session imports/exports a CLI workspace archive when true.';

comment on column public.agent_sessions.workspace_owner is
  'Opaque user or API-key identity authorized to access private CLI workspace handoffs.';
