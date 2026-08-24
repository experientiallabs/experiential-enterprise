import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; teamId: string }>;
};

/** Rename one team (backend admin-gated). */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json()) as { name?: unknown };
    const name = requireField(typeof payload.name === "string" ? payload.name : null, "name");
    return jsonOk(await getDataSource().renameOrgTeam(orgId, teamId, name));
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Delete one team. The backend refuses (409) while active keys are assigned;
 * `?force=true` passes through and detaches them, and the response reports
 * how many keys were unassigned.
 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, teamId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const force = new URL(request.url).searchParams.get("force") === "true";
    return jsonOk(await getDataSource().deleteOrgTeam(orgId, teamId, { force }));
  } catch (error) {
    return jsonError(error);
  }
}
