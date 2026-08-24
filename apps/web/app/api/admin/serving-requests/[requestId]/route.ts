import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ requestId: string }>;
};

/**
 * Why one served call routed where it did: the model the policy chose, its
 * reason for choosing it, the provider id behind that model, the router's own
 * cost, the metered leg, and a cluster only when a cluster-routing policy
 * served the call.
 *
 * Operator surface. A non-admin gets the not-found a missing route would give,
 * never a forbidden: Telemetry describes an endpoint as "optimized" and says
 * nothing about routing, so a tenant must not be able to learn that a
 * per-decision audit exists. The gate runs before the data source is touched.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  if (!(await isPlatformAdmin())) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const { requestId } = await routeParams(context.params);
    // Never cached: an operator reads this while debugging a live report.
    return jsonOk(await getDataSource().getServingRequestAudit(requestId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}
