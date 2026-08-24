import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { ServingWindow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

const WINDOW_KEYS: ServingWindow[] = ["24h", "7d", "30d"];

/** Suggestions from the interim rules engine over the org's own usage. */
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const window = new URL(request.url).searchParams.get("window");
    const suggestions = await getDataSource().getSuggestions(
      orgId,
      WINDOW_KEYS.includes(window as ServingWindow) ? (window as ServingWindow) : undefined
    );
    return jsonOk(suggestions, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
