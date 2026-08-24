import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/** The org's credit history (grants, top-ups, adjustments), newest first. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const ledger = await getDataSource().getOrgCreditLedger(orgId);
    return jsonOk(ledger, { "cache-control": "no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
