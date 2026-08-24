// The consolidated org-access primitive (E2). Every web-side membership
// check routes through `requireOrgAccess`: it resolves the identifier,
// enforces the minimum role, and — after membership passes — enforces the
// org's SSO requirement against the SESSION's authentication method (GoTrue
// AMR claims). Sessions are global to the user, so SSO binds at org ACCESS,
// not at login: a password session keeps working for non-SSO orgs and gets
// the step-up signal (`SsoStepUpRequiredError`) only when it touches an org
// whose verified domain requires SSO. Reads are gated too — this primitive
// sits under `requireOrgId`, which every org-scoped proxy route calls.

import { cache } from "react";

import { DataSourceNotFoundError, DataSourceRequestError } from "@/lib/errors";
import type { Org } from "@/lib/types";

import { isPlatformAdmin } from "./admin";
import { listAuthorizedOrgIds } from "./orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "./server";

export type OrgAccessRole = "user" | "admin";

/** GoTrue's AMR method for a SAML SSO sign-in. */
const SSO_AMR_METHOD = "sso/saml";

/**
 * The step-up signal: the session is a valid member but its authentication
 * method does not satisfy the org's SSO requirement. Active-org resolution
 * turns this into a redirect to `/signin?sso_required=<orgSlug>`; org-scoped
 * API routes surface it as `403 {"error": "sso_required"}` (lib/http.ts).
 */
export class SsoStepUpRequiredError extends Error {
  readonly orgId: string;
  readonly orgSlug: string;

  constructor(orgId: string, orgSlug: string) {
    super(`This organization requires single sign-on: ${orgSlug}`);
    this.name = "SsoStepUpRequiredError";
    this.orgId = orgId;
    this.orgSlug = orgSlug;
  }
}

// The org's SSO requirement, through the metadata-only definer RPC (the
// org_domains table itself is service-role-only). Two cache layers keep this
// enterprise check free for everyone else:
//
//   * a process-level TTL entry, so the steady state is ONE read per org per
//     pod per 30s instead of one per request — an org that never touches SSO
//     must not pay a round-trip on every page and proxy call;
//   * the request-scoped cache() on top, so a single render's layout gate,
//     page, and proxy calls share one resolution.
//
// The TTL is a deliberate enforcement latency: flipping sso_required on takes
// up to 30s to bind on a warm pod, which the feature tolerates by nature (the
// DNS verification that precedes it takes minutes, and step-up is a session
// gate, not a credential revocation). A transient read FAILURE degrades to
// the last known value (else false, logged): an enterprise-only read must
// never take down org pages for every tenant, and the same database outage
// would already be breaking sign-in itself.
const SSO_REQUIRED_TTL_MS = 30_000;
const ssoRequiredCache = new Map<string, { value: boolean; expiresAt: number }>();

/** Test seam: drop the process-level TTL entries between test cases. */
export function resetSsoRequiredCacheForTests(): void {
  ssoRequiredCache.clear();
}

export const getOrgSsoRequired = cache(async (orgId: string): Promise<boolean> => {
  const cached = ssoRequiredCache.get(orgId);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("org_sso_required", { in_org_id: orgId });
    if (error) {
      throw new Error(error.message);
    }
    const value = data === true;
    ssoRequiredCache.set(orgId, { value, expiresAt: Date.now() + SSO_REQUIRED_TTL_MS });
    return value;
  } catch (readError) {
    console.warn(
      `org_sso_required read failed for ${orgId}; using ${cached ? "last known value" : "false"}`,
      readError
    );
    return cached?.value ?? false;
  }
});

// Request-scoped point read of the caller's role in one org, under RLS as
// the user (it can only ever see their own membership rows).
const getMembershipRole = cache(
  async (userId: string, orgId: string): Promise<OrgAccessRole | null> => {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("organization_members")
      .select("role")
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) {
      throw new Error(`Unable to verify organization role: ${error.message}`);
    }
    if (!data) {
      return null;
    }
    return data.role === "admin" ? "admin" : "user";
  }
);

// Request-scoped: the newest AMR entry's method from the verified session
// claims. GoTrue appends an AMR entry per authentication event; the LATEST
// method is what the session currently is (a password session that later
// completes SSO step-up gains a newer sso/saml entry).
const getLatestAuthMethod = cache(async (): Promise<string | null> => {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) {
    return null;
  }
  const amr = (data.claims as { amr?: unknown }).amr;
  if (!Array.isArray(amr)) {
    return null;
  }
  let latest: { method: string; timestamp: number } | null = null;
  for (const entry of amr) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { method?: unknown }).method === "string" &&
      typeof (entry as { timestamp?: unknown }).timestamp === "number"
    ) {
      const candidate = entry as { method: string; timestamp: number };
      if (latest === null || candidate.timestamp > latest.timestamp) {
        latest = candidate;
      }
    }
  }
  return latest?.method ?? null;
});

/**
 * Gate one org identifier (UUID or slug) and return the canonical UUID.
 *
 * The order is deliberate: authentication, then membership at the required
 * strength, then the SSO requirement — so a non-member learns nothing (the
 * resource 404) and only a real member can ever receive the step-up signal.
 * Platform admins operate the deployment and pass every org check, the SSO
 * gate included (the backend's tenancy rule, mirrored here); everyone else
 * needs their session's latest authentication method to be the IdP's when
 * the org requires SSO.
 *
 * Throws `DataSourceNotFoundError` (404) for non-members, a 403
 * `DataSourceRequestError` for members below `minimumRole`, and
 * `SsoStepUpRequiredError` when only the authentication method is wrong.
 */
export async function requireOrgAccess(
  orgIdentifier: string,
  { minimumRole = "user" }: { minimumRole?: OrgAccessRole } = {}
): Promise<{ orgId: string; orgSlug: string }> {
  const user = await requireAuthenticatedUser();
  const authorizedOrgIds = await listAuthorizedOrgIds();
  const orgId = authorizedOrgIds.get(orgIdentifier);
  if (orgId === undefined) {
    throw new DataSourceNotFoundError(`Organization not found: ${orgIdentifier}`);
  }
  const platformAdmin = await isPlatformAdmin();
  if (!platformAdmin && minimumRole === "admin") {
    const role = await getMembershipRole(user.id, orgId);
    if (role === null) {
      // The authorized map said member, the role read says otherwise: the
      // membership was revoked mid-render. Fail as the resource 404.
      throw new DataSourceNotFoundError(`Organization not found: ${orgIdentifier}`);
    }
    if (role !== "admin") {
      throw new DataSourceRequestError("Organization admin role required.", 403);
    }
  }
  if (!platformAdmin && (await getOrgSsoRequired(orgId))) {
    const method = await getLatestAuthMethod();
    if (method !== SSO_AMR_METHOD) {
      throw new SsoStepUpRequiredError(orgId, slugForOrgId(authorizedOrgIds, orgId));
    }
  }
  return { orgId, orgSlug: slugForOrgId(authorizedOrgIds, orgId) };
}

// The authorized map keys every org by slug AND uuid; the slug is the
// non-uuid key pointing at the id (falls back to the id itself, which only
// happens if an org row carried no slug key).
function slugForOrgId(authorizedOrgIds: ReadonlyMap<string, string>, orgId: string): string {
  for (const [key, value] of authorizedOrgIds) {
    if (value === orgId && key !== orgId) {
      return key;
    }
  }
  return orgId;
}

/**
 * Tag the orgs that currently require SSO, for the membership-discovery
 * carve-out surfaces (`GET /api/orgs`, the org switcher): the flag is
 * enumerated carve-out metadata a member may always see, so they can
 * recognize the org and initiate step-up — while everything beyond
 * name/slug/flag stays behind the gate.
 */
export async function tagSsoRequiredOrgs<T extends Org>(orgs: readonly T[]): Promise<T[]> {
  if (orgs.length === 0) {
    return [];
  }
  // The tag is cosmetic (an "SSO" chip on the switcher): a failed read must
  // never break the org list for every tenant, so it degrades to untagged.
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("sso_required_org_ids", {
      in_org_ids: orgs.map((org) => org.id)
    });
    if (error) {
      throw new Error(error.message);
    }
    const required = new Set<string>(Array.isArray(data) ? data.map(String) : []);
    return orgs.map((org) => ({ ...org, sso_required: required.has(org.id) }));
  } catch (readError) {
    console.warn("sso_required_org_ids read failed; rendering orgs untagged", readError);
    return orgs.map((org) => ({ ...org, sso_required: false }));
  }
}
