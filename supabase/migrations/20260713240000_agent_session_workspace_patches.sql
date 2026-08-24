-- Incremental local workspace synchronization is announced through the same
-- durable session feed as transcript output. Patch bytes remain private in
-- Storage and the event carries only the opaque object revision.

alter table public.agent_session_events
  drop constraint agent_session_events_kind_check;

alter table public.agent_session_events
  add constraint agent_session_events_kind_check check (
    kind in (
      'user_message', 'assistant_message', 'tool_call', 'tool_output',
      'tool_result', 'submit', 'state', 'status', 'error', 'workspace_patch'
    )
  );
