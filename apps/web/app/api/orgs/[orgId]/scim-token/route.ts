import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk, routeParams } from "@/lib/http";
import type { ScimKeyPolicy } from "@/lib/scim";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org's SCIM bearer token lifecycle (E3, /ee), proxied from the backend.
 * Admin + capability gating live server-side; the mint response is the only
 * carrier of the plaintext bearer, so every answer is private/no-store.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const status = await getDataSource().getScimTokenStatus(orgId);
    return jsonOk(status, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const payload = (await request.json().catch(() => ({}))) as { key_policy?: unknown };
    const keyPolicy: ScimKeyPolicy = payload.key_policy === "keep" ? "keep" : "revoke";
    const minted = await getDataSource().mintScimToken(orgId, keyPolicy);
    return jsonOk(minted, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const orgId = await requireOrgId(orgIdentifier);
    const status = await getDataSource().revokeScimToken(orgId);
    return jsonOk(status, { "cache-control": "private, no-store" });
  } catch (error) {
    return jsonError(error);
  }
}
