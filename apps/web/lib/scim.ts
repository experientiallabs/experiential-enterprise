// Types for the SCIM provisioning settings surface (E3, /ee). Models the
// backend's SCIM token management API (explabs/api/routes/scim_admin.py);
// the browser reaches it through the /api/orgs/{orgId}/scim-token proxy
// route. Client-safe on purpose — no server imports — so the settings
// section can share these shapes.

/** The org's standing policy for user-created API keys at deprovision time. */
export type ScimKeyPolicy = "revoke" | "keep";

/** What an admin may see about the SCIM token after mint time (never the secret). */
export type ScimTokenStatus = {
  exists: boolean;
  last4: string | null;
  created_at: string | null;
  revoked_at: string | null;
  key_policy: ScimKeyPolicy | null;
};

/** The one response that ever carries the plaintext bearer. */
export type ScimTokenMint = {
  token: string;
  last4: string;
  created_at: string;
  key_policy: ScimKeyPolicy;
};
