import { tagSsoRequiredOrgs } from "@/lib/auth/org-access";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { filterAuthorizedOrgs, listAuthorizedOrgIds } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

// The membership-discovery carve-out (E2): this listing stays visible to any
// authenticated member session — a user who cannot see an SSO org exists can
// never initiate step-up to it — and carries the sso_required flag as the
// "SSO" tag. The carve-out is metadata-only; everything beyond the org list
// sits behind the org-access gate in requireOrgId.
export async function GET(): Promise<Response> {
  try {
    await requireAuthenticatedUser();
    const authorizedOrgIds = await listAuthorizedOrgIds();
    const orgs = filterAuthorizedOrgs(await getDataSource().listOrgs(), authorizedOrgIds);
    return jsonOk({ orgs: await tagSsoRequiredOrgs(orgs) });
  } catch (error) {
    return jsonError(error);
  }
}
