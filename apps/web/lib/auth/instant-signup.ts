import type { SupabaseClient } from "@supabase/supabase-js";

import { mintApiKeySecret } from "@/lib/api-keys/keys";
import { recordAuditEvent } from "@/lib/audit";

// Shared core for instant, passwordless account creation, used by the
// coding-agent endpoint (POST /api/signup/instant). It creates the account and
// API key immediately, but keeps spending LOCKED: the auth.users-insert trigger
// provisions the org, its $20 welcome grant, and the identities synchronously.
// The new org's organizations.spend_unlocked_at stays NULL, so the P1025 spend gate
// keeps the credits LOCKED until the founder proves inbox ownership. Login and
// spend-unlock are DECOUPLED (migration 20260826000000): email_confirm:true only
// permits login; the spend gate reads spend_unlocked_at, which inbox proof sets.
// Auth stays passwordless for the USER: the account carries a random bootstrap
// secret that is never shown to them. The user later signs in with an emailed
// code, never this secret.
//
// SECURITY NOTE (the product owner, updated 2026-08-27): this creates an account from an
// UNAUTHENTICATED email with no proof of inbox ownership. The primary defense is
// the SPEND GATE: the $20 stays locked until the founder proves inbox ownership
// (organizations.spend_unlocked_at). At unlock, rotate_credentials_on_spend_unlock
// tears down only NON-FOUNDER members added while locked (an attacker-invited
// co-admin: key revoked, session severed, membership evicted) — the founding
// admin's OWN instant key and sessions are PRESERVED so a legitimate user's wired
// key keeps working through verification (migration 20260827000000). ACCEPTED
// RESIDUAL RISK (the product owner): in the instant-signup-of-a-victim's-email case the
// attacker IS the founder, so their key survives and they could spend the grant
// if they wait for the real victim to verify — bounded by the $20 grant and the
// per-IP/per-address signup rate limits, accepted in favor of never revoking a
// legitimate founder's key. Callers also rate-limit to blunt bulk creation. Do
// NOT remove the spend gate or the non-founder rotation without removing these
// entry points, and do NOT re-add founder-key revocation.

export type InstantProvisionResult =
  | {
      status: "created";
      userId: string;
      orgId: string;
      // The minted key's plaintext, or null when the caller asked for no key.
      apiKeySecret: string | null;
      creditsGranted: number | null;
      // The random bootstrap secret set on the new account, so a caller that
      // needs an immediate session can use signInWithPassword. Never shown to
      // the user; the user signs in with an emailed code.
      sessionPassword: string;
    }
  | { status: "account_exists" }
  | { status: "signup_failed"; message: string };

// GoTrue surfaces a duplicate address as one of these; treat all as "exists".
function isAlreadyRegistered(error: {
  code?: string;
  status?: number;
  message?: string;
}): boolean {
  if (error.code === "email_exists" || error.code === "user_already_exists") {
    return true;
  }
  return (error.message ?? "").toLowerCase().includes("already registered");
}

/**
 * Provision a fresh instant account and mint its first org key.
 *
 * @param admin - Service-role client (bypasses RLS; server-only).
 * @param email - The already-validated signup email.
 * @param inviteToken - Optional invite token, consumed by the provisioning
 *   trigger from user metadata exactly as the emailed-code signup passes it.
 * @param keyName - Label for the minted key, or null to mint no key. A key
 *   minted here belongs to the FOUNDER, so it survives spend unlock and keeps
 *   working through verification (migration 20260827000000); it is spend-gated
 *   until inbox proof like everything else on the org.
 * @returns The created account's org, key secret (null when keyName is null),
 *   granted credits, and the bootstrap session secret; or "account_exists" for a
 *   known address (a known email must NOT yield a key or session — that would
 *   hand an existing org's access to anyone who knows the address); or
 *   "signup_failed".
 */
export async function provisionInstantAccount(
  admin: SupabaseClient,
  email: string,
  inviteToken: string | null,
  keyName: string | null
): Promise<InstantProvisionResult> {
  // GoTrue hashes this with bcrypt, which silently caps input at 72 BYTES and
  // errors (500 unexpected_failure) on some builds when handed more. Two raw
  // UUIDs plus the prefix is 81 chars, which broke EVERY new-account creation in
  // production; hyphen-stripped they are 64 chars (256 bits of entropy) and the
  // "xpl-" prefix keeps it at 68, safely under the cap. The user never sees this
  // secret; it is only available to a trusted caller that needs a session.
  const sessionPassword = `xpl-${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  // email_confirm:true so GoTrue permits a session mint when a caller needs one
  // (signInWithPassword refuses an unconfirmed email even under mailer_autoconfirm).
  // This governs LOGIN only;
  // the org's spend_unlocked_at stays NULL so credits remain spend-gated until
  // the founder proves inbox ownership via the verification link.
  const created = await admin.auth.admin.createUser({
    email,
    password: sessionPassword,
    email_confirm: true,
    user_metadata: inviteToken ? { invite_token: inviteToken } : undefined
  });
  if (created.error !== null || created.data.user === null) {
    if (created.error !== null && isAlreadyRegistered(created.error)) {
      return { status: "account_exists" };
    }
    return {
      status: "signup_failed",
      message: created.error?.message ?? "Could not create the account."
    };
  }
  const userId = created.data.user.id;

  // The org the auth.users-insert trigger just provisioned for this founder.
  const { data: membership, error: membershipError } = await admin
    .from("organization_members")
    .select("org_id")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (membershipError || !membership) {
    // Provisioning did not run (e.g. signups flipped off between a gate check
    // and here). Remove the orphan so a later invite can provision it.
    await admin.auth.admin.deleteUser(userId).catch(() => null);
    return {
      status: "signup_failed",
      message: "Account provisioning did not complete; try again."
    };
  }
  const orgId = membership.org_id as string;

  // Surface the welcome grant the org-insert trigger already applied at signup
  // (shown immediately, but locked by the spend gate until verification).
  const { data: orgRow } = await admin
    .from("organizations")
    .select("credit_granted_usd")
    .eq("id", orgId)
    .maybeSingle();
  const creditsGranted =
    typeof orgRow?.credit_granted_usd === "number" ? orgRow.credit_granted_usd : null;

  // Mint the org key only when the caller wants one (keyName != null). Passing
  // null creates no orphan key. A key minted here belongs to the founder and
  // survives unlock.
  let apiKeySecret: string | null = null;
  if (keyName !== null) {
    const minted = mintApiKeySecret();
    const { data: apiKey, error: insertError } = await admin
      .from("api_keys")
      .insert({
        org_id: orgId,
        name: keyName,
        key_prefix: minted.keyPrefix,
        key_suffix: minted.keySuffix,
        key_hash: minted.keyHash,
        created_by: userId
      })
      .select("id")
      .single();
    if (insertError || !apiKey) {
      return {
        status: "signup_failed",
        message: insertError?.message ?? "Could not mint an API key."
      };
    }
    // The instant-signup mint replaced the retired device-activation mint as
    // the agent path onto a working key, so it carries the same audit event.
    await recordAuditEvent(admin, {
      orgId,
      actorKind: "user",
      actorId: userId,
      action: "keys.mint",
      objectType: "api_key",
      objectId: apiKey.id,
      context: { via: "instant_signup" }
    });
    apiKeySecret = minted.secret;
  }

  return {
    status: "created",
    userId,
    orgId,
    apiKeySecret,
    creditsGranted,
    sessionPassword
  };
}
