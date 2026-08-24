import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string }> };

// The org's pending join requests (org admins only; backend-gated).
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const orgId = await requireOrgId((await context.params).orgId);
    return jsonOk(await getDataSource().listJoinRequests(orgId));
  } catch (error) {
    return jsonError(error);
  }
}
