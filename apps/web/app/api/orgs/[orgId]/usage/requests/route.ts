import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { usageRequestsQueryFromSearchParams } from "@/lib/gateway-telemetry";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/** One keyset page of the gateway request log, newest first. */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const query = usageRequestsQueryFromSearchParams(new URL(request.url).searchParams);
    const page = await getDataSource().listUsageRequests(orgId, query);
    return jsonOk(page, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
