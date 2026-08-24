// Types for the Domains & SSO settings surface (E2, /ee). Models the
// backend's org-domains and sso-provider APIs
// (explabs/api/routes/org_domains.py, explabs/api/routes/sso.py); the
// browser reaches them through the /api/orgs/{orgId}/domains and
// /api/orgs/{orgId}/sso-provider proxy routes. Client-safe on purpose —
// no server imports — so the settings panel can share these shapes.

/** One claimed domain, with the TXT record the operator must publish. */
export type OrgDomain = {
  domain: string;
  verified_at: string | null;
  sso_required: boolean;
  /** DNS record name verification looks for (`_explabs-verify.<domain>`). */
  txt_record_name: string;
  /** The server-generated challenge to publish as the TXT value. */
  txt_record_value: string;
  created_at: string | null;
};

/** The org's claimed domains, verified and pending alike. */
export type OrgDomainList = {
  org_id: string;
  domains: OrgDomain[];
};

export type SsoProviderType = "saml" | "oidc";

/** The customer-safe projection of the org's IdP (never any secret). */
export type SsoProvider = {
  provider_type: SsoProviderType;
  /** Non-secret IdP config: metadata_url (SAML) / issuer + client_id (OIDC). */
  metadata: Record<string, unknown>;
  default_role: "admin" | "user";
  enabled: boolean;
  has_client_secret: boolean;
};

/** One PUT body: the whole desired provider state, idempotently. */
export type SsoProviderUpsertInput = {
  provider_type: SsoProviderType;
  metadata: Record<string, unknown>;
  default_role: "admin" | "user";
  enabled: boolean;
  /** OIDC only; straight to Vault server-side, never echoed back. */
  client_secret?: string;
};
