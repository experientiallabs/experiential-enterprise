import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string; identityId: string; aliasId: string }> };

// Grant one alias to one identity (idempotent; org admins only).
export async function PUT(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, identityId, aliasId } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().addGrant(orgId, identityId, aliasId));
  } catch (error) {
    return jsonError(error);
  }
}

// Revoke one alias grant from one identity (idempotent; org admins only).
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, identityId, aliasId } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().removeGrant(orgId, identityId, aliasId));
  } catch (error) {
    return jsonError(error);
  }
}
