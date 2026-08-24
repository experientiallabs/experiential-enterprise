import { type NextRequest } from "next/server";

import { requireOrgId } from "@/lib/auth/orgs";
import { getDataSource } from "@/lib/data-source";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ orgId: string; budgetId: string }> };

// Remove one budget scope, restoring it to unlimited (org admins only).
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, budgetId } = await context.params;
    const orgId = await requireOrgId(orgIdentifier);
    return jsonOk(await getDataSource().deleteBudget(orgId, budgetId));
  } catch (error) {
    return jsonError(error);
  }
}
