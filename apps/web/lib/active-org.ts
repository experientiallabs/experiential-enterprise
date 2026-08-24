// The workspace's active organization. Root-level URLs (/models, /telemetry,
// ...) carry no org segment, so the org comes from this one resolver: the
// active-org cookie when it names an org the session may access, else the
// user's first authorized org. The org switcher writes the cookie through
// /api/active-org; old /{orgSlug}/... URLs permanently redirect through the
// same cookie so multi-org deep links still land in the right workspace.

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireOrgAccess, SsoStepUpRequiredError } from "@/lib/auth/org-access";
import {
  filterAuthorizedOrgs,
  listMembershipOrgIds,
  requireAuthorizedOrgIds
} from "@/lib/auth/orgs";
import { listOrgsCached } from "@/lib/data-cache";
import type { Org } from "@/lib/types";

export const ACTIVE_ORG_COOKIE = "explabs-active-org";

/**
 * The org every root-level workspace page renders for. Cached per request so
 * the layout, sidebar, and page share one resolution. A memberless session is
 * sent to the organizations page rather than a dead-end 404.
 */
export const resolveActiveOrg = cache(async (): Promise<Org> => {
  let org: Org | null;
  try {
    org = await selectSessionActiveOrg();
  } catch (error) {
    // The E2 step-up UX: the session is a member but its authentication
    // method does not satisfy the org's SSO requirement. Send it to sign-in
    // with the org named; the same session keeps working for non-SSO orgs
    // (the switcher writes the cookie without resolving the SSO org).
    if (error instanceof SsoStepUpRequiredError) {
      redirect(`/signin?sso_required=${encodeURIComponent(error.orgSlug)}`);
    }
    throw error;
  }
  if (!org) {
    redirect("/orgs");
  }
  return org;
});

// Next signals redirect()/notFound() by throwing; those must pass through
// any tolerant catch or the framework's control flow silently dies here.
function isNextControlFlowError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND")
  );
}

/**
 * The tolerant resolution: same as `resolveActiveOrg`, but "no active org"
 * is a valid answer. Telemetry identify enrichment needs it because the root
 * layout wraps signin, onboarding, and memberless sessions, none of which
 * may be redirected or failed just to enrich analytics; the settings layout
 * needs it for the same reason to resolve the enterprise capability nav flag
 * without breaking its render-for-every-audience contract. Every read below
 * is a request-cached accessor the workspace layout already pays for, so on
 * workspace pages this adds no second fetch.
 */
export const resolveActiveOrgForTelemetry = cache(async (): Promise<Org | null> => {
  try {
    return await selectSessionActiveOrg();
  } catch (error) {
    if (isNextControlFlowError(error)) {
      throw error;
    }
    // Swallowed by design (analytics never breaks a render), but traceably.
    console.warn(
      `telemetry org resolution failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
});

// One resolution shared by the redirecting workspace gate and the tolerant
// telemetry variant: the active-org cookie when it names an accessible org,
// else the user's first membership org.
async function selectSessionActiveOrg(): Promise<Org | null> {
  const authorizedOrgIds = await requireAuthorizedOrgIds();
  // `listOrgsCached` rather than a direct `listOrgs()`: the sidebar packet reads the
  // same list through that accessor, and two different function identities defeat
  // React's per-render memo, so every workspace page was fetching the org list twice.
  // The cookie read and the membership map are already resolved or local, so joining
  // them here costs nothing and keeps the org list as the only wait.
  const [jar, allOrgs, membershipOrgIds] = await Promise.all([
    cookies(),
    listOrgsCached(),
    listMembershipOrgIds()
  ]);
  const preferred = jar.get(ACTIVE_ORG_COOKIE)?.value ?? null;
  const orgs = filterAuthorizedOrgs(allOrgs, authorizedOrgIds);
  if (orgs.length === 0) {
    return null;
  }
  const preferredOrg =
    preferred !== null
      ? orgs.find((org) => org.slug === preferred || org.id === preferred)
      : undefined;
  // No cookie: default to an org the user is a MEMBER of, matching what the
  // org switcher offers. A platform admin's authorized list is the all-orgs
  // bypass, and its first row is the memberless default-models publisher org
  // (the product owner, 2026-07-31: a fresh admin session must open the experiential
  // workspace, not the publisher). Admins with no membership anywhere keep
  // the bypass fallback so ops-only accounts still land somewhere.
  const memberOrg = orgs.find(
    (org) => membershipOrgIds.has(org.id) || membershipOrgIds.has(org.slug)
  );
  const selected = preferredOrg ?? memberOrg ?? orgs[0];
  // The org-access gate, applied to the RESOLVED org whichever way it was
  // chosen (E2): membership alone does not resolve an sso_required org — the
  // session's method must be the org's IdP, or the SsoStepUpRequiredError
  // propagates to the caller (redirect in resolveActiveOrg, a tolerated null
  // for telemetry).
  await requireOrgAccess(selected.id, { minimumRole: "user" });
  return selected;
}

/** Cookie-independent lookup for redirect handlers: the org, if accessible. */
export async function findAuthorizedOrg(orgIdentifier: string): Promise<Org | null> {
  const authorizedOrgIds = await requireAuthorizedOrgIds();
  const orgs = filterAuthorizedOrgs(await listOrgsCached(), authorizedOrgIds);
  return (
    orgs.find((org) => org.slug === orgIdentifier || org.id === orgIdentifier) ?? null
  );
}
