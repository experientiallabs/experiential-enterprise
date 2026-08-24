-- Customer API keys are organization-scoped actors, not end-user UUIDs.
-- Their hosted sessions therefore have no created_by user, and their steering
-- commands have no actor_id user while remaining fully tenant-authorized by
-- the API before the service-role insert.

alter table public.agent_session_commands
  alter column actor_id drop not null;

comment on column public.agent_session_commands.actor_id is
  'End-user UUID for user-authored commands; null for organization API-key actors.';
