import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";
import type { UpdateIdentityInput } from "@/lib/identities/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string; identityId: string }> };

// Rename, redescribe, or (de)activate one identity (org admins only).
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, identityId } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);
    const body = (await request.json()) as UpdateIdentityInput;
    return jsonOk(await getDataSource().updateIdentity(orgId, identityId, body));
  } catch (error) {
    return jsonError(error);
  }
}

// Disable one identity (soft; org admins only).
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, identityId } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().disableIdentity(orgId, identityId));
  } catch (error) {
    return jsonError(error);
  }
}
