import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Lift (or restore) one organization's free-credit daily caps. The caps
 * otherwise bind until the org's first paid top-up; this is the support
 * override the admin Orgs panel toggles. Platform-admin surface; the backend
 * enforces the same gate on its side.
 */
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const body = (await request.json().catch(() => null)) as { lifted?: unknown } | null;
    if (typeof body?.lifted !== "boolean") {
      return NextResponse.json(
        { error: "lifted must be a boolean (true lifts the caps, false restores them)." },
        { status: 400 }
      );
    }
    const result = await getDataSource().putAdminFreeCreditCaps(orgId, body.lifted);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
