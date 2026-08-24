// Enterprise capability gate (the /ee seam). Enterprise-only surfaces resolve
// their capability here and render NOTHING when it is not available — the
// page 404s exactly like an absent surface, never a grayed-out upsell.

import { getDataSource } from "./data-source";

export type CapabilityState = "available" | "unlicensed" | "absent";

// Pinned to the backend registry (explabs/api/capabilities.py
// EnterpriseCapability); the SSO, SCIM, Teams, and data-controls surfaces
// gate on the same keys. Do not rename.
export type OrgCapability = "audit_log" | "sso" | "scim" | "teams" | "data_controls";

/**
 * Resolve one org's full capability map from the backend registry
 * (GET /api/orgs/{orgId}/capabilities). Server-side only: it rides the
 * deployment-key data source like every other backend read. Callers gating
 * several surfaces in one render (the settings nav) use this so the registry
 * is fetched once.
 *
 * Fails CLOSED: any fetch failure, missing key, or unrecognized state reads
 * as "unlicensed" — an erroring registry must render the surface absent,
 * never available.
 */
export async function getOrgCapabilities(
  orgId: string
): Promise<Record<OrgCapability, CapabilityState>> {
  let raw: Record<string, string> = {};
  try {
    raw = (await getDataSource().getOrgCapabilities(orgId)).capabilities;
  } catch {
    raw = {};
  }
  return {
    audit_log: normalizedState(raw.audit_log),
    sso: normalizedState(raw.sso),
    scim: normalizedState(raw.scim),
    teams: normalizedState(raw.teams),
    data_controls: normalizedState(raw.data_controls)
  };
}

/** Resolve one org's state for a single enterprise capability (fail-closed). */
export async function getOrgCapability(
  orgId: string,
  capability: OrgCapability
): Promise<CapabilityState> {
  return (await getOrgCapabilities(orgId))[capability];
}

function normalizedState(state: string | undefined): CapabilityState {
  switch (state) {
    case "available":
    case "absent":
      return state;
    default:
      return "unlicensed";
  }
}
