-- File browsing and CLI patch uploads may briefly resume an intentionally
-- paused live-session sandbox. Keep that independently accumulated usage out
-- of the driver's single-writer active-window counter so concurrent flushes
-- cannot overwrite it.

alter table public.agent_sessions
  add column sandbox_access_seconds bigint not null default 0
  check (sandbox_access_seconds >= 0);

comment on column public.agent_sessions.sandbox_access_seconds is
  'Sandbox seconds from API file and patch access that resumed an idle snapshot; added atomically and folded into sandbox_seconds by the driver.';

create function public.add_agent_session_sandbox_access_seconds(
  in_session uuid,
  in_seconds bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total bigint;
begin
  update public.agent_sessions
     set sandbox_access_seconds = sandbox_access_seconds + greatest(in_seconds, 0)
   where id = in_session
     and status in ('starting', 'running', 'ending')
  returning sandbox_access_seconds into v_total;
  return v_total;
end;
$$;

revoke all on function public.add_agent_session_sandbox_access_seconds(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.add_agent_session_sandbox_access_seconds(uuid, bigint)
  to service_role;
