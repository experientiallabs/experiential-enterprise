import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { DataSourceRequestError } from "@/lib/errors";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { SsoProviderUpsertInput } from "@/lib/sso";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org's IdP registration (E2, /ee), proxied from the backend. Admin +
 * capability gating and the metadata/secret validation all live server-side;
 * this route canonicalizes the org identifier and forwards the typed body
 * (the OIDC client secret passes straight through to the backend's Vault
 * path and is never logged or echoed).
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const provider = await getDataSource().getOrgSsoProvider(orgId);
    return jsonOk(provider, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json()) as Partial<SsoProviderUpsertInput>;
    if (payload.provider_type !== "saml" && payload.provider_type !== "oidc") {
      throw new DataSourceRequestError("provider_type must be saml or oidc.", 400);
    }
    const input: SsoProviderUpsertInput = {
      provider_type: payload.provider_type,
      metadata: payload.metadata ?? {},
      default_role: payload.default_role === "admin" ? "admin" : "user",
      enabled: payload.enabled === true,
      ...(payload.client_secret ? { client_secret: payload.client_secret } : {})
    };
    const provider = await getDataSource().putOrgSsoProvider(orgId, input);
    return jsonOk(provider, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const deleted = await getDataSource().deleteOrgSsoProvider(orgId);
    return jsonOk(deleted, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
