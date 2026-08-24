import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";

// Spend-unlock is the SEPARATE signal that opens the P1025 credit spend gate,
// decoupled from login (migration 20260826000000). Code verification logs the
// user in but leaves organizations.spend_unlocked_at NULL until inbox proof is
// complete (spend gated);
// spend is unlocked only when the founding admin PROVES INBOX OWNERSHIP —
// clicking the emailed verification magic link (/auth/callback) or entering the
// emailed 6-digit code (/auth/otp/verify). Setting spend_unlocked_at both opens
// the gate and fires the credential-rotation trigger, which tears down only
// attacker-added NON-founder members (keys revoked, sessions severed, membership
// evicted); the founding admin's own key and sessions are PRESERVED (migration
// 20260827000000) so a legitimate user's wired key keeps working.
//
// Deliberately NOT called from a bootstrap-secret session: minting such a
// session is NOT inbox proof, so it must never unlock spend.

/**
 * Unlock platform-credit spending for the org(s) the user FOUNDED, if still
 * locked. Delegates to the `public.unlock_founder_spend` definer function
 * (migration 20260826000000), which sets `spend_unlocked_at` on every locked org
 * where the user is the FOUNDING admin — the earliest-joined `role='admin'`
 * membership. This scope is security-critical: unlocking on any admin membership
 * would let an attacker who instant-signed-up a victim's address invite a second
 * admin they control and unlock (and drain) the victim's founding org without
 * ever proving the victim's inbox. Keying on the earliest admin covers every
 * founder path (self-serve and invite-to-found-a-new-org) while excluding a
 * later-invited admin. Setting `spend_unlocked_at` also fires credential
 * rotation, which evicts attacker-added non-founder members but preserves the
 * founder's own key and sessions.
 *
 * Idempotent (the function no-ops on already-unlocked orgs) and best-effort: a
 * failure here must never fail the sign-in that triggered it — the spend gate
 * simply stays closed and the user can retry from the overview banner.
 *
 * @param admin - Service-role client (spend_unlocked_at is not RLS-reachable by
 *   the user, and the definer function revokes across the org).
 * @param userId - The user who just proved inbox ownership.
 */
export async function unlockSpendForUser(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    await admin.rpc("unlock_founder_spend", { p_user_id: userId });
  } catch {
    // Best-effort: never let an unlock hiccup block the sign-in.
  }
}

/**
 * What unlocks platform-credit spending, read from the platform-wide
 * `app_settings.spend_unlock_requirement` flag (migration 20260827130000):
 *
 *   'email' (default) - the founding admin proves inbox ownership.
 *   'card'            - a saved Stripe payment method is attached to the org.
 *
 * The P1025 spend gate always reads `organizations.spend_unlocked_at`; this flag
 * only selects WHICH event sets it, so the two triggers below can route on it.
 * Ships 'email', and any unreadable/unknown value falls back to 'email' so a
 * settings hiccup can never silently switch the platform's unlock contract.
 */
export type SpendUnlockRequirement = "email" | "card";

export async function spendUnlockRequirement(
  admin: SupabaseClient
): Promise<SpendUnlockRequirement> {
  try {
    const { data, error } = await admin
      .from("app_settings")
      .select("spend_unlock_requirement")
      .maybeSingle();
    if (error !== null || data === null) {
      return "email";
    }
    const value = (data as { spend_unlock_requirement: string }).spend_unlock_requirement;
    switch (value) {
      case "email":
      case "card":
        return value;
      default:
        // An out-of-contract value (a bad manual write) must not open or reshape
        // the gate: fall back to the default inbox-proof requirement.
        console.error(`spend-unlock: unknown spend_unlock_requirement '${value}', using 'email'`);
        return "email";
    }
  } catch {
    return "email";
  }
}

/**
 * Org-scoped unlock primitive for 'card' mode: delegates to the
 * `public.unlock_org_spend` definer function (migration 20260827130000), which
 * sets `spend_unlocked_at` on the org if still locked and fires the same
 * credential rotation as the founder path. Best-effort, mirroring
 * `unlockSpendForUser`.
 */
export async function unlockSpendForOrg(admin: SupabaseClient, orgId: string): Promise<void> {
  try {
    await admin.rpc("unlock_org_spend", { p_org_id: orgId });
  } catch {
    // Best-effort: never let an unlock hiccup fail the webhook that saved the card.
  }
}

/**
 * Inbox-proof unlock trigger (the emailed magic link / 6-digit code). Unlocks
 * only in 'email' mode; in 'card' mode inbox proof alone no longer unlocks
 * (a saved card is required, via {@link unlockSpendOnCardSaved}). At the default
 * 'email' mode this is exactly the prior `unlockSpendForUser` behavior.
 */
export async function unlockSpendOnInboxProof(
  admin: SupabaseClient,
  userId: string
): Promise<void> {
  if ((await spendUnlockRequirement(admin)) !== "email") {
    return;
  }
  await unlockSpendForUser(admin, userId);
}

/**
 * Saved-card unlock trigger (the Stripe webhook persisting a payment method).
 * Unlocks only in 'card' mode; in the default 'email' mode saving a card has no
 * spend-gate effect (unchanged from today). Best-effort, org-scoped.
 */
export async function unlockSpendOnCardSaved(
  admin: SupabaseClient,
  orgId: string
): Promise<void> {
  if ((await spendUnlockRequirement(admin)) !== "card") {
    return;
  }
  await unlockSpendForOrg(admin, orgId);
}

/**
 * Whether the given org has unlocked platform-credit spending. Drives the
 * "verify your email to use your credits" overview banner: credits are granted
 * and shown at signup but the P1025 gate keeps them locked until this is true.
 * Reads organizations.spend_unlocked_at with the service role (not in the JWT).
 * Returns true when unknown so a transient failure never nags an unlocked org.
 */
export async function isOrgSpendUnlocked(orgId: string): Promise<boolean> {
  try {
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin
      .from("organizations")
      .select("spend_unlocked_at")
      .eq("id", orgId)
      .maybeSingle();
    if (error !== null || data === null) {
      return true;
    }
    return (data as { spend_unlocked_at: string | null }).spend_unlocked_at !== null;
  } catch {
    return true;
  }
}
