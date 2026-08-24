import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { USAGE_ROLLUP_LIMIT_CAP, type PlatformUsageGroupBy } from "@/lib/gateway-usage";
import { jsonError, jsonOk, parseLimitParam, pickParam } from "@/lib/http";

export const dynamic = "force-dynamic";

const GROUP_BYS: readonly PlatformUsageGroupBy[] = ["day", "model", "org"];

/**
 * The admin Telemetry panel's platform-wide usage read: the gateway rollup
 * summed across every organization, proxied to the backend's platform read.
 * Platform-admin surface; a non-admin gets the not-found a missing route
 * would give (the backend re-enforces the same gate). Per-org drilldowns
 * reuse GET /api/gateway/usage/daily, whose org gate platform admins already
 * pass.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isPlatformAdmin())) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const url = new URL(request.url);
    const groupBy = pickParam(url.searchParams.get("group_by"), GROUP_BYS, "day");
    if (groupBy === null) {
      return Response.json({ error: "Invalid group_by" }, { status: 400 });
    }
    const limit = parseLimitParam(url.searchParams.get("limit"), USAGE_ROLLUP_LIMIT_CAP);
    if (limit === null) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    const usage = await getDataSource().getGatewayUsagePlatformDaily({
      groupBy,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      limit
    });
    // A live operator surface: never let a browser or proxy cache serve
    // stale cross-org figures.
    return jsonOk(usage, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
