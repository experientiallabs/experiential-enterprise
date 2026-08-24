import { requireOrgId } from "@/lib/auth/orgs";
import type { ProviderPolicyInput } from "@/lib/data-controls";
import { getDataSource } from "@/lib/data-source";
import { DataSourceRequestError } from "@/lib/errors";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org's provider data-control policy (E5.3, /ee), proxied from the
 * backend. Role and DATA_CONTROLS capability gating plus the allowlist
 * validation all live server-side; this route canonicalizes the org
 * identifier and forwards the typed body. Enforcement of a written policy is
 * always-on in the gateway worker regardless of licensing.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().getProviderPolicy(orgId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json()) as Partial<ProviderPolicyInput>;
    const allowed = payload.allowed_providers;
    if (
      allowed !== null &&
      allowed !== undefined &&
      (!Array.isArray(allowed) || allowed.some((provider) => typeof provider !== "string"))
    ) {
      throw new DataSourceRequestError("allowed_providers must be null or a list of provider ids.", 400);
    }
    const input: ProviderPolicyInput = {
      allowed_providers: allowed ?? null,
      require_zdr: payload.require_zdr === true,
      require_no_training: payload.require_no_training === true
    };
    return jsonOk(await getDataSource().putProviderPolicy(orgId, input), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().deleteProviderPolicy(orgId), {
      "cache-control": "private, no-store"
    });
  } catch (error) {
    return jsonError(error);
  }
}
