import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; teamId: string; userId: string }>;
};

/** Add one org member to the team (backend admin-gated, idempotent). */
export async function PUT(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId, userId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().addOrgTeamMember(orgId, teamId, userId));
  } catch (error) {
    return jsonError(error);
  }
}

/** Remove one member from the team (backend admin-gated). */
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId, userId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().removeOrgTeamMember(orgId, teamId, userId));
  } catch (error) {
    return jsonError(error);
  }
}
