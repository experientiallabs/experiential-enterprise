// A short-lived, org-scoped serving credential for one playground exchange.
//
// The gateway's /v1 edge authenticates the Bearer as a customer `xpl_` key and
// derives the org and its deny-by-default grants from that key's row. The
// control-plane deployment bearer (EXPLABS_API_KEY) is NOT a serving key -- it
// has no api_keys row and no identity -- so the worker rejects it with "The
// gateway key is invalid, expired, or revoked." The playground therefore mints
// a real org key for the call and revokes it the moment the stream ends: the
// browser never holds a serving credential, usage attributes to the org, and no
// lasting key clutters the org's key list (revoked keys are hidden from it).

import type { SupabaseClient } from "@supabase/supabase-js";

import { mintApiKeySecret } from "@/lib/api-keys/keys";
import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";

// The org's default identity id, mirroring the gateway control store's
// organization_artifact_id(org_id) == `org-<uuid>` (explabs/gateway/
// control_store.py). A minted key carries this identity so the org's seeded
// public-catalog grants apply; a key with a null identity holds no grant under
// deny-by-default and cannot route.
const ORG_IDENTITY_PREFIX = "org-";

// Display name for the default identity, byte-identical to the one the
// gateway_backfill_identity_tier() cutover writes (and the forthcoming new-org
// seed trigger, #503, will write), so a row this path creates is
// indistinguishable from a structurally-seeded one.
const DEFAULT_IDENTITY_DISPLAY_NAME = "Default";

// The name every ephemeral playground key carries, so a row that outlives its
// request (a crash between mint and revoke) is recognizable as machine-issued.
const PLAYGROUND_KEY_NAME = "Playground session";

export type PlaygroundServingKey = {
  /** The plaintext `xpl_` secret to present to the /v1 gateway edge. */
  secret: string;
  /** Revoke the key so it stops authenticating; safe to call more than once. */
  revoke: () => Promise<void>;
};

/**
 * Ensure the org's default gateway identity row exists, returning its id.
 *
 * The mint below inserts into api_keys, whose identity_id is a foreign key to
 * gateway_identities. On main today the only paths that create identity rows are
 * the one-shot gateway_backfill_identity_tier() (orgs existing at migration
 * time) and this helper, so any org created after that migration -- every new
 * signup and every seeded org -- has no default identity and the mint 500s. This
 * get-or-create closes the FK for ANY org. The id and display name match the
 * backfill exactly (and the forthcoming new-org seed trigger, #503), and the
 * insert is idempotent (ignore the unique-violation on a concurrent create), so
 * it composes with those instead of duplicating rows.
 *
 * @param admin Service-role client (granted this table; bypasses RLS).
 * @param orgId Canonical org uuid that owns the identity.
 * @returns The default identity id, `org-<uuid>`.
 */
export async function ensureOrgDefaultIdentity(
  admin: SupabaseClient,
  orgId: string
): Promise<string> {
  const identityId = `${ORG_IDENTITY_PREFIX}${orgId}`;
  const { error } = await admin.from("gateway_identities").upsert(
    { identity_id: identityId, org_id: orgId, display_name: DEFAULT_IDENTITY_DISPLAY_NAME },
    { onConflict: "identity_id", ignoreDuplicates: true }
  );
  if (error !== null) {
    throw new Error(`Could not provision the org's default gateway identity: ${error.message}`);
  }
  return identityId;
}

/**
 * Mint a short-lived serving key for one playground exchange.
 *
 * @param orgId Canonical org uuid the key authorizes and attributes usage to.
 * @param userId Signed-in user recorded as the key's creator.
 * @returns The plaintext secret and a revoke handle to call when the stream ends.
 */
export async function mintPlaygroundServingKey(
  orgId: string,
  userId: string
): Promise<PlaygroundServingKey> {
  const admin = createServiceRoleSupabaseClient();
  // A banned org may not gain new serving credentials, and this mint is a real
  // org key. An org ban severs member sessions, so the only caller who can
  // still reach this is a not-yet-expired access token (the accepted residual
  // JWT window) or a platform admin browsing the banned tenant; refuse both.
  const { data: orgRow, error: orgBanError } = await admin
    .from("organizations")
    .select("banned_at")
    .eq("id", orgId)
    .maybeSingle();
  if (orgBanError !== null) {
    throw new Error(`Could not check the organization's ban state: ${orgBanError.message}`);
  }
  if (orgRow?.banned_at != null) {
    throw new Error("This organization is banned. The playground cannot serve it.");
  }
  // api_keys.identity_id has an FK to gateway_identities. On main the one-shot
  // P-A backfill only seeded orgs existing at migration time, so every org
  // created after it lands with no default identity and the mint below trips
  // api_keys_identity_id_fkey. Get-or-create the org's default identity here so
  // the mint never 500s for ANY org -- the id is the same 'org-' || org_id the
  // control store synthesizes (and #503's new-org seed trigger will write), so
  // this composes with them (ON CONFLICT DO NOTHING semantics) rather than
  // diverging. service_role is granted this table and bypasses RLS.
  const identityId = await ensureOrgDefaultIdentity(admin, orgId);
  // Deliberately NOT audited (enterprise audit trail): this implicit
  // playground key is infrastructure the product mints for itself on first
  // playground use, and recording it would only add noise per new member.
  const minted = mintApiKeySecret();
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      org_id: orgId,
      name: PLAYGROUND_KEY_NAME,
      key_prefix: minted.keyPrefix,
      key_suffix: minted.keySuffix,
      key_hash: minted.keyHash,
      created_by: userId,
      identity_id: identityId
    })
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw new Error(
      `Could not provision a playground serving key: ${error?.message ?? "no row returned"}`
    );
  }
  const keyId = data.id as string;
  let revoked = false;
  return {
    secret: minted.secret,
    async revoke() {
      if (revoked) {
        return;
      }
      revoked = true;
      await admin.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", keyId);
    }
  };
}
