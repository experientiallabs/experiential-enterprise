import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; domain: string }>;
};

/**
 * Run the backend's real DNS TXT verification for one claimed domain. A
 * mismatch comes back as the backend's 409 (`txt_record_not_found`) with
 * the record name to publish; the panel shows it verbatim.
 */
export async function POST(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, domain } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const verified = await getDataSource().verifyOrgDomain(orgId, domain);
    return jsonOk(verified, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
