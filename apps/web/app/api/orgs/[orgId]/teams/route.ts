import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Org teams, proxied from the backend like the other org-scoped panels. The
 * backend enforces the TEAMS capability and org role per acting user; this
 * route only canonicalizes the org identifier.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().listOrgTeams(orgId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}

/** Create one team (backend admin-gated). */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json()) as { name?: unknown };
    const name = requireField(typeof payload.name === "string" ? payload.name : null, "name");
    return jsonOk(await getDataSource().createOrgTeam(orgId, name));
  } catch (error) {
    return jsonError(error);
  }
}
