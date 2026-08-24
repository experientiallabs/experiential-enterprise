import { cache } from "react";

import type { Org } from "@/lib/types";

import { isPlatformAdmin } from "./admin";
import { requireOrgAccess } from "./org-access";
import { createServerSupabaseClient, requireAuthenticatedUser } from "./server";

type AuthorizedOrgRow = {
  organizations: { id: string; slug: string } | { id: string; slug: string }[] | null;
};

/**
 * Every identifier the caller may address an organization by (its UUID and its
 * slug), mapped to that organization's canonical UUID.
 *
 * The value half is what removes the request tax: the same query that decides
 * whether the caller may touch an org already returns that org's id, so a route
 * that needs only `org.id` can canonicalize a slug URL out of this map instead
 * of paying a second, cross-region fetch of the whole org list. `has()` behaves
 * exactly as it did when this was a Set, so the membership filters are unchanged.
 */
export type AuthorizedOrgIds = ReadonlyMap<string, string>;

// Request-scoped: the caller's OWN organization memberships, resolved from one Supabase
// query per render. Keyed by both UUID and slug so callers can address either. This is the
// list a user actually belongs to, no platform-admin bypass, so it drives surfaces that
// should read as "your organizations" (the sidebar org switcher). The user filter is
// EXPLICIT: RLS scopes ordinary users to their own rows, but the platform-admin
// select-all policy (organization_members_platform_admin_all) admits EVERY membership
// row, which made the switcher list every org for operators (the product owner: admins should see
// only the orgs they were actually invited to, like everyone else; the admin pages are
// how they reach the rest).
export const listMembershipOrgIds = cache(async (): Promise<AuthorizedOrgIds> => {
  const user = await requireAuthenticatedUser();
  const supabase = await createServerSupabaseClient();
  const orgIds = new Map<string, string>();
  const { data, error } = await supabase
    .from("organization_members")
    .select("organizations(id, slug)")
    .eq("user_id", user.id);
  if (error) {
    throw new Error(`Unable to verify organization membership: ${error.message}`);
  }
  const memberOrgs: { id: string; slug: string }[] = [];
  for (const row of (data ?? []) as AuthorizedOrgRow[]) {
    // supabase-js types nested selects loosely; normalize object-or-array.
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!org) {
      continue;
    }
    memberOrgs.push(org);
  }
  setIdentifierKeys(orgIds, memberOrgs);
  return orgIds;
});

// Slug keys first, uuid keys second, so a canonical uuid always resolves to its
// own org: a slug that happens to equal another accessible org's uuid must never
// hijack addressing by id (it merely becomes unreachable as a slug).
function setIdentifierKeys(
  orgIds: Map<string, string>,
  orgs: readonly { id: string; slug: string }[]
): void {
  for (const org of orgs) {
    orgIds.set(org.slug, org.id);
  }
  for (const org of orgs) {
    orgIds.set(org.id, org.id);
  }
}

// Request-scoped: the layout access gate and every page's `requireOrgId` resolve the same
// authorized-org map. Platform admins pass every org gate (the backend's tenancy rule, mirrored
// here): their map is built from the select-all organizations policy, which is how they reach
// memberless orgs like demo-examples by URL for ops. Non-admins fall back to their own
// memberships, so for them this map equals `listMembershipOrgIds`. The org switcher deliberately
// lists memberships instead (see loadOrgShell) so a memberless template org never clutters it,
// while this gate still lets an admin open that org directly.
export const listAuthorizedOrgIds = cache(async (): Promise<AuthorizedOrgIds> => {
  // Both reads start together. A non-admin, which is every customer session, resolves
  // to the membership map, and gating that query behind the admin probe made the common
  // case pay two serial round-trips where one would do. An admin pays one extra
  // concurrent membership read, which never lengthens the critical path.
  const membership = listMembershipOrgIds();
  // An admin's result comes from the all-orgs read below and never reads this
  // promise, so absorb its rejection here rather than leaving it unhandled. The
  // original promise still rejects into the non-admin return path.
  membership.catch(() => {});
  if (!(await isPlatformAdmin())) {
    return membership;
  }
  const supabase = await createServerSupabaseClient();
  const orgIds = new Map<string, string>();
  const { data, error } = await supabase.from("organizations").select("id, slug");
  if (error) {
    throw new Error(`Unable to verify organization access: ${error.message}`);
  }
  setIdentifierKeys(orgIds, (data ?? []) as { id: string; slug: string }[]);
  return orgIds;
});

/**
 * Gate an org identifier (UUID or slug) and return the organization's canonical UUID.
 *
 * The authorization decision is made fresh on every call. Nothing here is cached
 * across requests, so a revoked membership stops working on the very next request.
 * Callers that need only the id (nearly every /api/orgs proxy does) get slug
 * canonicalization for free from the same query, with no org-list fetch.
 *
 * Delegates to `requireOrgAccess` (lib/auth/org-access.ts), the consolidated
 * org-access primitive, so every caller inherits the SSO step-up gate: a
 * member session whose authentication method does not satisfy an
 * `sso_required` org throws `SsoStepUpRequiredError` here rather than
 * reading anything.
 */
export async function requireOrgId(orgIdentifier: string): Promise<string> {
  const { orgId } = await requireOrgAccess(orgIdentifier, { minimumRole: "user" });
  return orgId;
}

export async function requireAuthorizedOrgIds(): Promise<AuthorizedOrgIds> {
  await requireAuthenticatedUser();
  return listAuthorizedOrgIds();
}

export function filterAuthorizedOrgs<T extends Org>(
  orgs: readonly T[],
  authorizedOrgIds: AuthorizedOrgIds
): T[] {
  return orgs.filter((org) => {
    return authorizedOrgIds.has(org.id);
  });
}


