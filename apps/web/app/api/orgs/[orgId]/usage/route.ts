import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/** Authenticated, uncached usage proxy used by the live organization rollup. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const usage = await getDataSource().getOrgUsage(orgId);
    return jsonOk(usage, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
