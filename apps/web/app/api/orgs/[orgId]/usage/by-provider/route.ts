import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { ServingWindow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

const WINDOW_KEYS: ServingWindow[] = ["24h", "7d", "30d"];

/** Per-provider ("platform") gateway usage rollups for the Telemetry Usage card. */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const raw = new URL(request.url).searchParams.get("window");
    const window = WINDOW_KEYS.includes(raw as ServingWindow)
      ? (raw as ServingWindow)
      : undefined;
    const usage = await getDataSource().getUsageByProvider(orgId, window);
    return jsonOk(usage, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
