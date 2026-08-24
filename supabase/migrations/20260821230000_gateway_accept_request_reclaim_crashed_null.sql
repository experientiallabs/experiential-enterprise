-- Restore keyed-retry liveness after an owner crashes mid-request.
--
-- `gateway_accept_request` is reached only by a request that has already been
-- granted replay ownership (the replay store hands out a fresh owner token when
-- it takes over a `claimed` lease whose TTL elapsed). Before this change the
-- ledger then raised P1021 for ANY prior whose `terminal_state` was not one of
-- the two crash-reconciled states — including a prior still sitting at
-- `terminal_state IS NULL` because its owner died before publishing and before
-- `gateway_reconcile_crashed` ran. That left every same-key retry failing
-- closed ("resend with a new Idempotency-Key") for up to the reconcile interval
-- (~1h in production), even though the replay layer had already declared the
-- retry the new owner. The two layers disagreed: takeover said "re-dispatch",
-- the ledger said "stop".
--
-- Fix: treat a never-terminal prior whose `deadline_at` has already elapsed as
-- reclaimable, exactly like the crash-reconciled states — it is a dead owner by
-- definition (past its own deadline, still not terminal). This only anticipates
-- what the reconciler would do anyway; both crash states are already
-- reclaimable, so the money guarantee is unchanged. At-most-once stays intact
-- for genuinely settled priors (`completed`/`failed`/`cancelled`/`incomplete`
-- still raise P1021) and for a prior still IN FLIGHT within its deadline
-- (`terminal_state IS NULL` with `deadline_at` in the future still raises
-- P1021 — the NULL-safe `coalesce` below is load-bearing for that case).
create or replace function public.gateway_accept_request(
  p_request_id pg_catalog.text,
  p_org_id pg_catalog.uuid,
  p_api_key_id pg_catalog.uuid,
  p_alias pg_catalog.text,
  p_alias_revision_id pg_catalog.text,
  p_api_surface pg_catalog.text,
  p_canonical_request_sha256 pg_catalog.text,
  p_caller_operation_sha256 pg_catalog.text,
  p_deadline_at pg_catalog.timestamptz
)
returns pg_catalog.void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior record;
  v_existing public.gateway_requests%rowtype;
  v_reclaimable pg_catalog.bool;
begin
  perform public.gateway_require_service_role();
  if p_deadline_at is null then
    raise exception using errcode = '22023',
      message = 'accepted gateway request requires a deadline';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = p_api_key_id and keys.org_id = p_org_id
  ) then
    raise exception using errcode = '42501',
      message = 'gateway request key attribution is invalid';
  end if;
  if not exists (
    select 1 from public.api_keys keys
    where keys.id = p_api_key_id
      and keys.revoked_at is null
      and (keys.expires_at is null
        or keys.expires_at > pg_catalog.clock_timestamp())
  ) then
    raise exception using errcode = '42501',
      message = 'gateway request api key is revoked or expired';
  end if;
  -- Replay receipt: a retried accept RPC (worker retried after a lost
  -- response) is a no-op when the durable row matches; drifted content under
  -- the same request id is refused with a typed conflict, never a raw
  -- constraint error.
  select requests.* into v_existing
    from public.gateway_requests requests
   where requests.request_id = p_request_id;
  if v_existing.request_id is not null then
    if v_existing.org_id <> p_org_id
       or v_existing.api_key_id is distinct from p_api_key_id
       or v_existing.alias_revision_id <> p_alias_revision_id
       or v_existing.api_surface <> p_api_surface
       or v_existing.canonical_request_sha256 <> p_canonical_request_sha256
       or v_existing.caller_operation_sha256
         is distinct from p_caller_operation_sha256 then
      raise exception using errcode = '23505',
        message = 'gateway request id is bound to different accepted content';
    end if;
    return;
  end if;
  if p_caller_operation_sha256 is not null then
    -- Serialize concurrent accepts of the same caller operation: without
    -- this, two simultaneous submissions with one Idempotency-Key both pass
    -- the probe below (neither sees the other's uncommitted insert) and the
    -- operation dispatches — and charges — twice.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'gateway_accept_request:' || p_org_id::pg_catalog.text || ':'
        || p_alias_revision_id || ':' || p_api_surface || ':'
        || p_caller_operation_sha256,
        0
      )
    );
    select requests.canonical_request_sha256,
           requests.terminal_state,
           requests.deadline_at
      into v_prior
      from public.gateway_requests requests
     where requests.org_id = p_org_id
       and requests.alias_revision_id = p_alias_revision_id
       and requests.api_surface = p_api_surface
       and requests.caller_operation_sha256 = p_caller_operation_sha256
     order by requests.accepted_at desc
     limit 1;
    if v_prior.canonical_request_sha256 is not null then
      if v_prior.canonical_request_sha256 <> p_canonical_request_sha256 then
        raise exception using errcode = 'P1020',
          message = 'idempotency_conflict: the caller operation key was reused '
            || 'with different request content; mint a new Idempotency-Key';
      end if;
      -- Reclaimable iff the prior is a dead owner: a crash-reconciled state, or
      -- a never-terminal row whose own deadline has already passed. `coalesce`
      -- keeps a still-in-flight NULL prior (deadline in the future) fail-closed
      -- rather than letting the SQL three-valued `and`/`or` fall through.
      v_reclaimable := coalesce(
        v_prior.terminal_state in (
          'expired_before_dispatch', 'unknown_after_crash'
        )
        or (
          v_prior.terminal_state is null
          and v_prior.deadline_at < pg_catalog.clock_timestamp()
        ),
        false
      );
      if not v_reclaimable then
        raise exception using errcode = 'P1021',
          message = 'idempotency_replay_unavailable: a matching keyed request '
            || 'exists but durable content replay is unavailable; resend the '
            || 'full request with a new Idempotency-Key';
      end if;
    end if;
  end if;
  insert into public.gateway_requests (
    request_id, org_id, api_key_id, alias, alias_revision_id, api_surface,
    canonical_request_sha256, caller_operation_sha256, accepted_at, deadline_at
  ) values (
    p_request_id, p_org_id, p_api_key_id, p_alias, p_alias_revision_id,
    p_api_surface, p_canonical_request_sha256, p_caller_operation_sha256,
    pg_catalog.clock_timestamp(), p_deadline_at
  );
end;
$$;
