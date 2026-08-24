import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * The org's developer-tool vendor accounts (E2B for everyone; Greptile, Cursor,
 * Devin for YC orgs). A management read like the provider-connections list: the
 * same admin gate hides it from members, and the backend decides which vendors
 * the org may see. The credits view drops YC-gated vendors for a non-YC org.
 */
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await context.params;
    const user = await requireAuthenticatedUser();
    const orgId = await requireOrgId(orgIdentifier);
    const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const accounts = await getDataSource().listToolAccounts(orgId);
    return NextResponse.json(accounts);
  } catch (error) {
    return jsonError(error);
  }
}
