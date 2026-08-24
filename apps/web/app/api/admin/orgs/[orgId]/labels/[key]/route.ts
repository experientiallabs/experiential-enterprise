import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; key: string }>;
};

/** Remove a label from an org (idempotent). Platform-admin surface. */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId, key } = await context.params;
    await getDataSource().removeAdminOrgLabel(orgId, key);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
