-- Configurable spend-unlock requirement (OPTION, default OFF).
--
-- Today platform-credit SPENDING unlocks when the founding admin proves INBOX
-- ownership (organizations.spend_unlocked_at set by public.unlock_founder_spend,
-- migration 20260826000000). This adds a platform-wide MODE flag so the unlock
-- trigger can later be switched to "a saved payment method (Stripe) is attached"
-- WITHOUT changing the P1025 spend gate itself: the gate still reads
-- spend_unlocked_at, only the CONDITION that sets it changes.
--
--   'email' (DEFAULT)  -> inbox proof unlocks (current behavior, unchanged).
--   'card'             -> a saved card unlocks (public.unlock_org_spend, below),
--                         and inbox proof alone no longer unlocks.
--
-- Ships defaulting to 'email' so nothing changes now; flipping the single
-- app_settings row to 'card' enables card-gating. The web layer
-- (lib/auth/spend-unlock.ts) reads this flag and routes the two unlock triggers
-- (inbox proof vs. card saved) accordingly. Kept on app_settings — the existing
-- single-row global platform-settings table (migration 20260708060000) that
-- already holds signups_enabled — rather than a new table, because the mode is
-- one platform-wide launch decision, not per-org state.

alter table public.app_settings
  add column if not exists spend_unlock_requirement pg_catalog.text not null
    default 'email'
    check (spend_unlock_requirement in ('email', 'card'));

comment on column public.app_settings.spend_unlock_requirement is
  'What unlocks platform-credit SPENDING for a locked org: ''email'' (default) = '
  'the founding admin proving inbox ownership (unlock_founder_spend); ''card'' = '
  'a saved Stripe payment method attached to the org (unlock_org_spend). The '
  'P1025 gate always reads organizations.spend_unlocked_at; only which event '
  'sets it changes. Ships ''email'' so behavior is unchanged until flipped.';

-- ---------------------------------------------------------------------------
-- public.unlock_org_spend(p_org_id): the 'card' mode unlock primitive.
--
-- Org-scoped counterpart to unlock_founder_spend: the saved card is attached to
-- the ORG (persisted on org_auto_recharge_settings by the Stripe webhook), so
-- card proof is org-level, not per-user. Sets spend_unlocked_at on the given org
-- if still locked, which ALSO fires rotate_credentials_on_spend_unlock exactly
-- as the founder path does (attacker-added non-founder members evicted, the
-- founder's own key and sessions preserved). Idempotent: no-ops on an already
-- unlocked org (the `is null` guard) and on an unknown org. security definer so
-- the service-role webhook can set a column the customer JWT cannot reach; the
-- MODE decision lives in the web layer, so this stays a pure primitive.
-- ---------------------------------------------------------------------------
create or replace function public.unlock_org_spend(p_org_id pg_catalog.uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organizations orgs
     set spend_unlocked_at = pg_catalog.now()
   where orgs.id = p_org_id
     and orgs.spend_unlocked_at is null;
end;
$$;

revoke all on function public.unlock_org_spend(pg_catalog.uuid)
  from public, anon, authenticated;
grant execute on function public.unlock_org_spend(pg_catalog.uuid) to service_role;
