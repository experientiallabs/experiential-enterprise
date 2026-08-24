import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { DataSourceRequestError } from "@/lib/errors";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; domain: string }>;
};

/**
 * Toggle sso_required on one verified domain. The backend enforces the
 * no-lockout invariant (an enabled provider must exist before the flag can
 * turn on) and refuses unverified domains.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, domain } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json()) as { sso_required?: boolean };
    if (typeof payload.sso_required !== "boolean") {
      throw new DataSourceRequestError("sso_required must be a boolean.", 400);
    }
    const updated = await getDataSource().setOrgDomainSsoRequired(
      orgId,
      domain,
      payload.sso_required
    );
    return jsonOk(updated, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

/** Remove one claimed domain. */
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, domain } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const deleted = await getDataSource().deleteOrgDomain(orgId, domain);
    return jsonOk(deleted, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
