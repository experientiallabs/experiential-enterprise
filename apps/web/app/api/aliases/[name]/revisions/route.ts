import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ name: string }> };

// A named alias's repoint history, newest first.
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { name } = await routeParams(context.params);
    const orgId = requireField(new URL(request.url).searchParams.get("org_id"), "org_id");
    return jsonOk(await getDataSource().listNamedAliasRevisions(orgId, name));
  } catch (error) {
    return jsonError(error);
  }
}
