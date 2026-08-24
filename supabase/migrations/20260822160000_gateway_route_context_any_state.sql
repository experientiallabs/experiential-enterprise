-- Route context is written by a background writer now (ledger.py enqueues it
-- off the pre-first-token hot path), so it can land AFTER the attempt has
-- terminalized. The original function required state = 'dispatched' and raised
-- otherwise, which -- with the async writer -- would drop route_reason /
-- fallback_reason whenever provider completion won the race.
--
-- These are display-only columns (the learned-selection reason a UI shows);
-- setting them on a terminal attempt is harmless and carries no money or state
-- semantics. Relax the guard to update the attempt in ANY state, still keyed
-- to one attempt_id and still display-safe validated; only a genuinely absent
-- attempt is an error. CREATE OR REPLACE preserves the service_role-only ACL.

create or replace function public.gateway_record_route_context(
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
  -- Any state: the async writer may arrive after settlement. Display-only, so
  -- a terminal attempt is a valid target; only an absent attempt is an error.
  update public.gateway_attempts
     set route_reason = p_route_reason,
         fallback_reason = p_fallback_reason
   where attempt_id = p_attempt_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'gateway route context requires an existing attempt';
  end if;
end;
$$;
