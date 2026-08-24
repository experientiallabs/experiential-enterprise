import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org's enterprise capability states, proxied from the backend registry
 * like the other org-scoped panels. The backend member-gates the read per the
 * acting user; this route only canonicalizes the org identifier. Unlicensed
 * keys drive ABSENT rendering client-side — never upsell chrome.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const capabilities = await getDataSource().getOrgCapabilities(orgId);
    return jsonOk(capabilities, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
