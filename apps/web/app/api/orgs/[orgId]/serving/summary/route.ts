import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { ServingWindow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

const WINDOW_KEYS: ServingWindow[] = ["24h", "7d", "30d"];

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const params = new URL(request.url).searchParams;
    const rawWindow = params.get("window");
    const summary = await getDataSource().getServingSummary(orgId, {
      endpoint: params.get("endpoint") ?? undefined,
      window: WINDOW_KEYS.includes(rawWindow as ServingWindow)
        ? (rawWindow as ServingWindow)
        : undefined
    });
    return jsonOk(summary);
  } catch (error) {
    return jsonError(error);
  }
}
