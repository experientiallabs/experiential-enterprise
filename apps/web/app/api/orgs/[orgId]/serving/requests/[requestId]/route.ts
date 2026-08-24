import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; requestId: string }>;
};

export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, requestId } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const request = await getDataSource().getServingRequest(orgId, requestId);
    return jsonOk({ request });
  } catch (error) {
    return jsonError(error);
  }
}
