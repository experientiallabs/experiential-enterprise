-- Cost controls: denormalize the dispatching key onto gateway_attempts.
--
-- Every host-lane admission decision is a per-key scan over gateway_attempts:
-- the RPM window (P1012), the daily spend cap (P1011), and -- added by this
-- packet -- the TPM window (P1022) and per-key monthly budgets (P1023). Today
-- those scans reach the key through gateway_requests (requests.api_key_id ->
-- attempts by request_id), which the planner drives from
-- gateway_requests_key_accepted_idx with NO time bound: the work grows with
-- the key's lifetime request count, not with the 60-second/one-day window
-- actually being measured. This is the "denormalizing identity/alias onto
-- gateway_attempts is a later optimization (Q5)" flagged in 20260820100000,
-- done now for the key dimension because this packet adds two more scans to
-- the same seam.
--
-- attempts.api_key_id is an attribution snapshot stamped at dispatch from the
-- accepted request's key, with the same ON DELETE SET NULL courtesy as
-- gateway_requests.api_key_id -- deleting a key never deletes spend history,
-- and a nulled key matches no per-key gate (its org/team budgets still count
-- the spend via org_id). gateway_start_attempt stamps it from 20260822130000
-- onward; the backfill below covers every existing row, and 20260822130000
-- re-runs it to catch any row dispatched between the two migrations by the
-- not-yet-replaced function.

alter table public.gateway_attempts
  add column api_key_id pg_catalog.uuid
    references public.api_keys(id) on delete set null;

comment on column public.gateway_attempts.api_key_id is
  'Dispatching key, denormalized from the accepted request at reserve time so per-key gates (RPM, TPM, daily cap, key budgets) scan window-bounded indexes instead of the key''s lifetime requests. Attribution courtesy: null after key deletion, never blocks history.';

update public.gateway_attempts attempts
   set api_key_id = requests.api_key_id
  from public.gateway_requests requests
 where requests.request_id = attempts.request_id
   and attempts.api_key_id is null
   and requests.api_key_id is not null;

-- One partial index per gate shape, all host-lane only (the only lane any
-- money gate reads):
--   * (api_key_id, budget_period_start) -- daily cap equality scan and the
--     monthly per-key budget range scan.
--   * (api_key_id, started_at)          -- RPM trailing 60s window.
--   * (api_key_id, terminal_at)         -- TPM trailing 60s settled-token
--     window (terminal rows only; dispatched rows have no tokens yet).
create index gateway_attempts_key_period_idx
  on public.gateway_attempts (api_key_id, budget_period_start)
  where billing_source = 'host_managed';
create index gateway_attempts_key_started_idx
  on public.gateway_attempts (api_key_id, started_at)
  where billing_source = 'host_managed';
create index gateway_attempts_key_terminal_idx
  on public.gateway_attempts (api_key_id, terminal_at)
  where billing_source = 'host_managed' and terminal_at is not null;
