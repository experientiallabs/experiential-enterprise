import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; teamId: string }>;
};

/** One team's roster (backend member-strength read). */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().listOrgTeamMembers(orgId, teamId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}
