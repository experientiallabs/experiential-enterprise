-- Atomic claim for the re-triggerable welcome celebration (fast-follow to #783).
--
-- The web POST /api/account/welcome-trigger read the user's seen marker, compared
-- it to the org's activation, then upserted. Two concurrent tabs both read the
-- old marker, both passed the "not yet seen" check, and both showed the
-- once-only celebration. This replaces that read-then-write with ONE atomic
-- conditional upsert, so exactly one racing caller wins the showing.

create function public.claim_welcome_trigger_showing(
  in_org pg_catalog.uuid,
  in_triggered_at pg_catalog.timestamptz
)
returns pg_catalog.bool
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user pg_catalog.uuid := public.authenticated_user_id();
  v_claimed pg_catalog.bool;
begin
  -- No verified subject → nothing to claim (the shell degrades to silent).
  if v_user is null then
    return false;
  end if;
  -- Advance THIS user's seen marker to the activation, but only when it is
  -- newer than what they last saw. The partial ON CONFLICT ... WHERE means a
  -- duplicate (marker already at/after this activation) updates no row, so
  -- RETURNING yields a row ONLY for the call that actually inserted or advanced
  -- the marker — exactly one racing caller wins, the rest get false. Definer so
  -- the write is not bounded by RLS; the row written is always the caller's own
  -- (v_user from the verified JWT), never another user's.
  insert into public.user_welcome_trigger_seen (user_id, org_id, seen_triggered_at)
    values (v_user, in_org, in_triggered_at)
  on conflict (user_id, org_id) do update
    set seen_triggered_at = excluded.seen_triggered_at
    where public.user_welcome_trigger_seen.seen_triggered_at < excluded.seen_triggered_at
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_welcome_trigger_showing(
  pg_catalog.uuid, pg_catalog.timestamptz
) from public, anon;
-- Members call it from their own session; the definer body derives the user
-- from the JWT and only ever writes that user's own seen row.
grant execute on function public.claim_welcome_trigger_showing(
  pg_catalog.uuid, pg_catalog.timestamptz
) to authenticated, service_role;
