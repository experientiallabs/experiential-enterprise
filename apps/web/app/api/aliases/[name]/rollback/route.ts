import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ name: string }> };

// Roll a named alias back to one of its prior revisions.
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { name } = await routeParams(context.params);
    const body = (await request.json()) as { org_id?: string; revision_id?: string };
    const orgId = requireField(body.org_id, "org_id");
    const revisionId = requireField(body.revision_id, "revision_id");
    return jsonOk(await getDataSource().rollbackNamedAlias(orgId, name, revisionId));
  } catch (error) {
    return jsonError(error);
  }
}
