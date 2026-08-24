import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string; alertId: string }> };

// Remove one spend-alert rule (org admins only; the backend enforces it).
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, alertId } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().deleteSpendAlert(orgId, alertId));
  } catch (error) {
    return jsonError(error);
  }
}
