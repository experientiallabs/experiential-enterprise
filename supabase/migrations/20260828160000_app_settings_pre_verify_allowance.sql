-- ---------------------------------------------------------------------------
-- Platform-wide pre-verify spend allowance.
--
-- Adds one column to the existing single-row public.app_settings config table
-- (created in 20260708060000_invites_and_signup_gate.sql): the micro-USD an
-- UNVERIFIED founder may spend of platform credits before the P1025 spend gate
-- blocks them.
--
--   * default 1_000_000 (= $1): a fresh founder can spend up to $1 of granted
--     credit before proving inbox ownership, so the gateway works instantly
--     without handing out the whole grant to an unverified address.
--   * 0: full email-verification-required — the pre-#634 behavior for the
--     whole grant (block ALL unverified spend).
--
-- Ownership split: this migration owns the STORAGE (column, default, check).
-- The gateway spend gate (owned by the promo-caps lane) READS this exact
-- column inside gateway_start_attempt, which is SECURITY DEFINER and therefore
-- bypasses RLS — no additional grant is needed for the gateway to read it, the
-- same way provision_signup_org already reads app_settings.signups_enabled
-- from a definer trigger. The admin panel toggles it through the service-role
-- backend (app_settings already grants service_role select/insert/update/delete).
--
-- app_settings is a singleton (single row, singleton boolean PK), so the NOT
-- NULL DEFAULT populates the existing row on both a fresh DB and one that
-- already ran the invites/signup-gate migration.
-- ---------------------------------------------------------------------------

alter table public.app_settings
  add column pre_verify_allowance_micro_usd pg_catalog.int8 not null default 1000000
    check (pre_verify_allowance_micro_usd >= 0);

comment on column public.app_settings.pre_verify_allowance_micro_usd is
  'Micro-USD an unverified founder may spend of platform credits before the P1025 spend gate blocks them. 0 = full email verification required for all credits (block all unverified spend, the pre-#634 behavior); 1000000 = $1. Read by the gateway spend gate (gateway_start_attempt, SECURITY DEFINER) and toggled from the admin panel via the service role.';
