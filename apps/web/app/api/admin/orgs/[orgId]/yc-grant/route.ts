import { NextResponse } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Mark an org a YC company and apply the launch grant with an admin-chosen
 * amount and expiry (3-month default when omitted). Platform-admin surface;
 * idempotent per org. This is the admin "org tags" YC control — applying the
 * `yc` tag AND its grant in one action.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const grant: { amount_usd?: number; expires_at?: string } = {};
    if (typeof body?.amount_usd === "number") {
      grant.amount_usd = body.amount_usd;
    }
    if (typeof body?.expires_at === "string" && body.expires_at.trim() !== "") {
      grant.expires_at = body.expires_at.trim();
    }
    const result = await getDataSource().postAdminYcGrant(orgId, grant);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
