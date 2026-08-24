import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import {
  USAGE_ROLLUP_LIMIT_CAP,
  type GatewayUsageGroupBy,
  type GatewayUsageScope
} from "@/lib/gateway-usage";
import { jsonError, jsonOk, parseLimitParam, pickParam } from "@/lib/http";

export const dynamic = "force-dynamic";

const SCOPES: readonly GatewayUsageScope[] = ["self", "org"];
const GROUP_BYS: readonly GatewayUsageGroupBy[] = ["day", "day_model", "model", "member"];

/**
 * The Overview page's usage read, proxied to the backend's gateway rollup.
 * Enum params are validated here so a bad query is a 400 at this boundary;
 * date strings pass through (the backend rejects malformed dates), and the
 * backend enforces membership plus the scope=self actor rule.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const orgIdentifier = url.searchParams.get("org");
    if (orgIdentifier === null) {
      return Response.json({ error: "Missing org parameter" }, { status: 400 });
    }
    const scope = pickParam(url.searchParams.get("scope"), SCOPES, "self");
    const groupBy = pickParam(url.searchParams.get("group_by"), GROUP_BYS, "day");
    if (scope === null || groupBy === null) {
      return Response.json({ error: "Invalid scope or group_by" }, { status: 400 });
    }
    const limit = parseLimitParam(url.searchParams.get("limit"), USAGE_ROLLUP_LIMIT_CAP);
    if (limit === null) {
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    }
    // Resolve id-or-slug and gate access; the backend keys on the UUID.
    const orgId = await requireOrgId(orgIdentifier);
    const usage = await getDataSource().getGatewayUsageDaily(orgId, {
      scope,
      groupBy,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      limit
    });
    return jsonOk(usage, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
