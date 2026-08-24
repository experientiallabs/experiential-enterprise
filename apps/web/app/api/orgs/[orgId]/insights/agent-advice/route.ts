import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { ServingWindow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

const WINDOW_KEYS: ServingWindow[] = ["24h", "7d", "30d"];

/**
 * Run the on-demand advice agent over the org's own usage aggregates.
 * Read-only and org-scoped: the agent explores the same content-free rollups
 * the Insights page renders and returns suggestions in the stable contract.
 * Without a platform LLM credential the backend answers a clean 503 and the
 * rule-based suggestions remain the baseline.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const raw = new URL(request.url).searchParams.get("window");
    const window = WINDOW_KEYS.includes(raw as ServingWindow)
      ? (raw as ServingWindow)
      : undefined;
    const suggestions = await getDataSource().runAgentAdvice(orgId, window);
    return jsonOk(suggestions, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
