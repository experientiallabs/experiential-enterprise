import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string; requestId: string }> };

// Deny one join request; nothing else changes (org admins only).
export async function POST(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: identifier, requestId } = await context.params;
    const orgId = await requireOrgId(identifier);
    return jsonOk(await getDataSource().denyJoinRequest(orgId, requestId));
  } catch (error) {
    return jsonError(error);
  }
}
