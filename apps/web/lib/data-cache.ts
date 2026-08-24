import { cache } from "react";

import { tagSsoRequiredOrgs } from "./auth/org-access";
import { filterAuthorizedOrgs, listMembershipOrgIds, requireOrgId } from "./auth/orgs";
import { getDataSource } from "./data-source";
import { DataSourceNotFoundError } from "./errors";
import type { Org, ServingEndpoint } from "./types";

// Request-scoped memoization. React `cache()` keys on (function identity, args) for
// the lifetime of a single server render, so the streaming sidebar and the page body
// share one fetch per endpoint instead of issuing duplicates. Each accessor resolves
// `getDataSource()` lazily so test mocks and per-request config still apply.

export const listOrgsCached = cache((): Promise<Org[]> => getDataSource().listOrgs());

/**
 * Served-endpoints probe behind the sidebar's Telemetry gate. Request-scoped
 * like the rest of the shell packet: the sidebar and any page-body consumer
 * share one probe per render instead of issuing duplicates.
 */
export const listServingEndpointsCached = cache(
  (orgId: string): Promise<ServingEndpoint[]> => getDataSource().listServingEndpoints(orgId)
);

/**
 * Resolve one organization by id or slug from the request-cached org list.
 * The backend has no org detail endpoint — the list already carries
 * everything the shell renders — so a lookup miss maps to the same
 * `DataSourceNotFoundError` a detail fetch would raise.
 */
export const getOrgCached = cache(async (orgIdentifier: string): Promise<Org> => {
  const orgs = await listOrgsCached();
  const org = orgs.find(
    (candidate) => candidate.id === orgIdentifier || candidate.slug === orgIdentifier
  );
  if (!org) {
    throw new DataSourceNotFoundError(`Organization not found: ${orgIdentifier}`);
  }
  return org;
});

/**
 * Gate an org identifier (uuid or slug) and resolve it to the full Org record.
 *
 * Only for callers that read more than the id: the org list behind it is a
 * cross-region backend fetch, so a route that needs nothing but `org.id` should
 * call `requireOrgId` and skip this entirely.
 */
export async function requireOrg(orgIdentifier: string): Promise<Org> {
  const orgId = await requireOrgId(orgIdentifier);
  return getOrgCached(orgId);
}

/**
 * The single data packet the org sidebar needs to render: the org list for the
 * switcher and the active org. The switcher lists the caller's own memberships
 * (not the platform-admin access set) so a
 * memberless template org never clutters it; admins still reach such orgs by URL
 * and from the /orgs grid, which use the full authorized set.
 */
export type OrgShell = {
  orgs: Org[];
  currentOrg: Org;
};

/**
 * Assemble the sidebar packet from the cached endpoint accessors.
 *
 * A missing org propagates `DataSourceNotFoundError` from `getOrgCached` (the
 * caller maps it to a 404).
 */
export const loadOrgShell = cache(async (orgIdentifier: string): Promise<OrgShell> => {
  const [membershipOrgIds, allOrgs, currentOrg] = await Promise.all([
    listMembershipOrgIds(),
    listOrgsCached(),
    getOrgCached(orgIdentifier)
  ]);
  return {
    // The switcher lists the caller's memberships; an admin viewing a memberless org
    // by URL still sees it as the active org (currentOrg), just not in the list.
    // Tagged with sso_required (the E2 membership-discovery carve-out): the
    // switcher keeps showing an SSO org's name/slug plus the tag, so a member
    // can always find and step up to it.
    orgs: await tagSsoRequiredOrgs(filterAuthorizedOrgs(allOrgs, membershipOrgIds)),
    currentOrg
  };
});
