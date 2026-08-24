import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; teamId: string; keyId: string }>;
};

/** Attribute one of the org's API keys to the team (backend admin-gated). */
export async function PUT(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId, keyId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().assignOrgTeamKey(orgId, teamId, keyId));
  } catch (error) {
    return jsonError(error);
  }
}

/** Clear one API key's attribution to the team (backend admin-gated). */
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId, keyId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().unassignOrgTeamKey(orgId, teamId, keyId));
  } catch (error) {
    return jsonError(error);
  }
}
