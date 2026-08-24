import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    // Resolve id-or-slug (the sidebar polls with the slug) and gate access;
    // the backend keys on the UUID.
    const orgId = await requireOrgId(orgIdentifier);
    const budget = await getDataSource().getOrgBudget(orgId);
    return jsonOk({ budget }, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
