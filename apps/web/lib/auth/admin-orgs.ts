import { cache } from "react";

import { DataSourceNotFoundError, DataSourceRequestError } from "@/lib/errors";

import { requireOrgAccess, SsoStepUpRequiredError } from "./org-access";
import { createServerSupabaseClient } from "./server";

export type AdminOrg = {
  id: string;
  name: string;
  slug: string;
  role: "admin";
};

// Organizations the user administers (admin membership). Queried under
// RLS as the user, so it can only ever return their own memberships.
// Request-scoped cache: the admin layout gate and the invites page both call
// this during one render, so a single query serves both.
export const listAdminOrgs = cache(async (userId: string): Promise<AdminOrg[]> => {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("organization_members")
    .select("role, organizations(id, name, slug)")
    .eq("user_id", userId)
    .eq("role", "admin");
  if (error) {
    throw new Error(`Unable to load administered organizations: ${error.message}`);
  }
  const orgs: AdminOrg[] = [];
  for (const row of data ?? []) {
    // supabase-js types nested selects loosely; normalize object-or-array.
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!org || row.role !== "admin") {
      continue;
    }
    orgs.push({ id: org.id, name: org.name, slug: org.slug, role: row.role });
  }
  return orgs.sort((a, b) => a.name.localeCompare(b.name));
});

// Point check for one org at any role. Delegates to the consolidated
// org-access primitive (E2) so the SSO step-up gate applies to every
// membership check: a "member?" answer for an sso_required org is only ever
// computed for a session whose method satisfies the requirement — the
// step-up signal propagates, it is never swallowed into `false`. The
// delegation also inherits the platform-admin bypass (operators pass every
// org gate, matching the backend's tenancy rule); every call site already
// ORs with `isPlatformAdmin()`, so no surface changes behavior.
export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  return delegatedRoleCheck(userId, orgId, "user");
}

// Point check for one org at admin strength — used on every invite mutation.
export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  return delegatedRoleCheck(userId, orgId, "admin");
}

// The session is the only identity requireOrgAccess can gate (the SSO check
// reads the session's own AMR claims); callers pass the session user's id,
// which these helpers keep in their signature for call-site stability.
async function delegatedRoleCheck(
  _userId: string,
  orgId: string,
  minimumRole: "user" | "admin"
): Promise<boolean> {
  try {
    await requireOrgAccess(orgId, { minimumRole });
    return true;
  } catch (error) {
    if (error instanceof SsoStepUpRequiredError) {
      throw error;
    }
    if (error instanceof DataSourceNotFoundError) {
      return false;
    }
    if (error instanceof DataSourceRequestError && error.status === 403) {
      return false;
    }
    throw error;
  }
}
