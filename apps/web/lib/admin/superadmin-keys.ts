import { mintKeySecret } from "@/lib/api-keys/keys";
import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";

// Superadmin machine keys (public.platform_admin_keys): `xpladmin_` + 40 hex
// (160 random bits), persisted only as a SHA-256 digest — the customer-key
// shape (lib/api-keys/keys.ts) scoped to platform operators. MINTING IS
// WEB-SESSION-ONLY by design: these functions run behind the platform-admin
// session gate over the service role, while the FastAPI layer only
// AUTHENTICATES the keys (live row + owner still in platform_admins), so a
// leaked superadmin key can never mint more superadmin keys. The ONLY mint
// call site is the site-admin grant route: a key is created for a newly
// granted operator and revealed once to the granter; Admin > Access lists
// and revokes. Revocation is an UPDATE setting revoked_at — the table's
// grants deliberately include no DELETE, so a key's audit trail survives its
// death.

const SECRET_PREFIX = "xpladmin_";

// Prefix + 8 hex kept for display recognition (`xpladmin_ab12cd34`), mirroring
// customer keys' 12-char `xpl_ab12cd34`; never enough to derive the secret.
const KEY_PREFIX_LENGTH = 17;

const KEY_COLUMNS =
  "id, user_id, owner_email, name, key_prefix, key_suffix, created_at, last_used_at, revoked_at";

/** One superadmin key as the admin surfaces read it — never the hash. */
export type SuperadminKeyRow = {
  id: string;
  /**
   * The operator this key acts as; dies with their platform_admins row.
   * Null once the owning account is deleted — the row is the audit record
   * and outlives its owner (a null owner is a dead credential).
   */
  user_id: string | null;
  /** Durable attribution captured at mint; survives account deletion. */
  owner_email: string;
  name: string;
  key_prefix: string;
  /** Last 4 chars of the plaintext, stored at mint for display recognition; null on keys minted before the column existed. */
  key_suffix: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/**
 * Mint a superadmin key for one operator. Returns the stored row and the
 * plaintext secret — the ONLY moment the secret exists outside the caller's
 * clipboard; only its hash is persisted.
 */
export async function mintSuperadminKey(
  name: string,
  userId: string,
  ownerEmail: string
): Promise<{ row: SuperadminKeyRow; secret: string }> {
  const { secret, keyPrefix, keySuffix, keyHash } = mintKeySecret(SECRET_PREFIX, KEY_PREFIX_LENGTH);
  const admin = createServiceRoleSupabaseClient();
  const { data, error } = await admin
    .from("platform_admin_keys")
    .insert({
      user_id: userId,
      owner_email: ownerEmail,
      name,
      key_prefix: keyPrefix,
      key_suffix: keySuffix,
      key_hash: keyHash
    })
    .select(KEY_COLUMNS)
    .single();
  if (error) {
    throw new Error(`Unable to mint the superadmin key: ${error.message}`);
  }
  return { row: data as SuperadminKeyRow, secret };
}

/** Every superadmin key (live and revoked), newest first. */
export async function listSuperadminKeys(): Promise<SuperadminKeyRow[]> {
  const admin = createServiceRoleSupabaseClient();
  const { data, error } = await admin
    .from("platform_admin_keys")
    .select(KEY_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Unable to list superadmin keys: ${error.message}`);
  }
  return (data ?? []) as SuperadminKeyRow[];
}

/**
 * Revoke every live superadmin key one operator holds. The site-admin REVOKE
 * path calls this so revocation is authoritative on the key rows themselves:
 * without it, keys are only dead through the platform_admins membership check
 * at auth time, and a later re-grant would REVIVE them. Returns the number of
 * keys revoked; idempotent (already-revoked keys are untouched).
 */
export async function revokeSuperadminKeysForUser(userId: string): Promise<number> {
  const admin = createServiceRoleSupabaseClient();
  const { data, error } = await admin
    .from("platform_admin_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    throw new Error(`Unable to revoke the user's superadmin keys: ${error.message}`);
  }
  return (data ?? []).length;
}

/**
 * Revoke a superadmin key: set revoked_at (never a SQL delete — the grant
 * forbids it). Idempotent-safe: an already-revoked key keeps its original
 * revoked_at. Returns false when no key has that id.
 */
export async function revokeSuperadminKey(id: string): Promise<boolean> {
  const admin = createServiceRoleSupabaseClient();
  const { data, error } = await admin
    .from("platform_admin_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    throw new Error(`Unable to revoke the superadmin key: ${error.message}`);
  }
  if ((data ?? []).length > 0) {
    return true;
  }
  // Nothing updated: either the key is already revoked (fine) or it never
  // existed (the caller's 404).
  const { data: existing, error: readError } = await admin
    .from("platform_admin_keys")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    throw new Error(`Unable to revoke the superadmin key: ${readError.message}`);
  }
  return existing !== null;
}
