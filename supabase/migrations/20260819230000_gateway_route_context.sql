-- Sanctioned write path for gateway attempt route context. The gateway tables
-- grant SELECT only, so the display-safe selection context WMO's executor
-- records after each dispatch (AttemptLedger.record_route_context) needs its
-- own security definer function; consumer is the worker ledger
-- (explabs/gateway/ledger.py).

create function public.gateway_record_route_context(
  p_attempt_id pg_catalog.text,
  p_route_reason pg_catalog.text,
  p_fallback_reason pg_catalog.text
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.gateway_require_service_role();
  if (p_route_reason is not null
      and (pg_catalog.char_length(p_route_reason) > 512
           or p_route_reason ~ '[[:cntrl:]]'))
     or (p_fallback_reason is not null
         and (pg_catalog.char_length(p_fallback_reason) > 512
              or p_fallback_reason ~ '[[:cntrl:]]')) then
    raise exception using errcode = '22023',
      message = 'gateway route context must be a short display-safe code';
  end if;
  update public.gateway_attempts
     set route_reason = p_route_reason,
         fallback_reason = p_fallback_reason
   where attempt_id = p_attempt_id and state = 'dispatched';
  if not found then
    raise exception using errcode = '23514',
      message = 'gateway route context requires a dispatched attempt';
  end if;
end;
$$;

revoke all on function public.gateway_record_route_context(
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) from public, anon, authenticated;
grant execute on function public.gateway_record_route_context(
  pg_catalog.text, pg_catalog.text, pg_catalog.text
) to service_role;
