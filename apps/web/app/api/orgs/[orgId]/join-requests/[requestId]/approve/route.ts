import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string; requestId: string }> };

// Approve one join request, granting the requester membership (org admins;
// backend answers 409 for an already-decided request, 404 for an unknown one).
export async function POST(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: identifier, requestId } = await context.params;
    const orgId = await requireOrgId(identifier);
    return jsonOk(await getDataSource().approveJoinRequest(orgId, requestId));
  } catch (error) {
    return jsonError(error);
  }
}
