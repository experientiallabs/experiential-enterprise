import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; requestId: string }>;
};

/**
 * One request's captured prompt, for the request log's expansion. Exists only
 * for orgs that opted into prompt capture (Settings -> Observability) and
 * within the capture retention window; otherwise 404.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, requestId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const prompt = await getDataSource().getCapturedPrompt(orgId, requestId);
    return jsonOk(prompt, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
