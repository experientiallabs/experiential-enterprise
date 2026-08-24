import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { usageTimeseriesQueryFromSearchParams } from "@/lib/gateway-telemetry";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/** Bucketed gateway usage for the Telemetry charts; filters compose. */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const query = usageTimeseriesQueryFromSearchParams(new URL(request.url).searchParams);
    const timeseries = await getDataSource().getUsageTimeseries(orgId, query);
    return jsonOk(timeseries, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
