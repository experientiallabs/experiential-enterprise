// Enterprise entitlement types for the admin Orgs panel (the hosted tier of
// the capability registry: one grant licenses one org for one /ee feature).

/** The five /ee capability keys, pinned to the backend registry. */
export const ENTERPRISE_CAPABILITIES = [
  "audit_log",
  "sso",
  "scim",
  "teams",
  "data_controls"
] as const;

export type EnterpriseCapabilityKey = (typeof ENTERPRISE_CAPABILITIES)[number];

/** Operator-facing labels; the keys stay the wire contract. */
export const CAPABILITY_LABELS: Record<EnterpriseCapabilityKey, string> = {
  audit_log: "Audit log",
  sso: "Domains & SSO",
  scim: "SCIM provisioning",
  teams: "Teams",
  data_controls: "Provider policy"
};

export type OrgEntitlement = {
  capability: string;
  granted_by: string | null;
  note: string | null;
  created_at: string | null;
  expires_at: string | null;
};

export type OrgEntitlementsList = {
  org_id: string;
  entitlements: OrgEntitlement[];
};

/** One grant row labeled with its org, for the admin Enterprise tab. */
export type DeploymentEntitlement = OrgEntitlement & {
  org_id: string;
  org_slug: string | null;
  org_name: string | null;
};
