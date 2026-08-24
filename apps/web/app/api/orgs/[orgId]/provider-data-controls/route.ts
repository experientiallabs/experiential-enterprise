import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The platform-curated provider data-posture matrix (E5.3), proxied from the
 * backend like the other org-scoped panels. Member-strength and deliberately
 * NOT capability-gated server-side — it is curated metadata about provider
 * defaults, not the org's own policy; this route only canonicalizes the org
 * identifier.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().getProviderDataControls(orgId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}
