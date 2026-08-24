import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import { servingRequestQueryFromSearchParams } from "@/lib/serving-telemetry";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const query = servingRequestQueryFromSearchParams(new URL(request.url).searchParams);
    const page = await getDataSource().listServingRequests(orgId, query);
    return jsonOk(page);
  } catch (error) {
    return jsonError(error);
  }
}
