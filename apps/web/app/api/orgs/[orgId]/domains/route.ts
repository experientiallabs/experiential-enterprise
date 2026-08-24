import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, requireField, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org's claimed domains (E2 SSO substrate), proxied from the backend
 * like the other org-scoped panels. The backend admin-gates AND
 * capability-gates every call; this route only canonicalizes the org
 * identifier (and, through `requireOrgId`, applies the SSO step-up gate).
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const domains = await getDataSource().listOrgDomains(orgId);
    return jsonOk(domains, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

/** Claim one domain; the response carries the TXT record to publish. */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json()) as { domain?: string };
    const domain = requireField(payload.domain, "domain");
    const created = await getDataSource().createOrgDomain(orgId, domain);
    return jsonOk(created, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
