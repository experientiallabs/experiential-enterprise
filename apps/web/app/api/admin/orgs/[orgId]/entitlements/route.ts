import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * List one org's enterprise entitlement grants (the hosted tier of the
 * capability registry). Platform-admin surface; the backend enforces the same
 * gate and answers 404 for everyone else.
 */
export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    return NextResponse.json(await getDataSource().listOrgEntitlements(orgId));
  } catch (error) {
    return jsonError(error);
  }
}
