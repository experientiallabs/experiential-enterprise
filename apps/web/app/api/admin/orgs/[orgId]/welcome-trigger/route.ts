import { NextResponse } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Read one org's current welcome-celebration trigger so the admin card seeds
 * from real persisted state instead of fabricated defaults. Platform-admin
 * surface; `trigger` is null when the org has never been armed.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const result = await getDataSource().getAdminWelcomeTrigger(orgId);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Arm or disarm the re-triggerable welcome celebration for one org, choosing
 * the announced credit figure and whether to surface the API key. Platform-
 * admin surface; activating re-shows the celebration on members' next enter.
 */
export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const trigger = {
      active: body?.active === true,
      display_credit_usd:
        typeof body?.display_credit_usd === "number" ? body.display_credit_usd : null,
      show_api_key: body?.show_api_key !== false
    };
    const result = await getDataSource().putAdminWelcomeTrigger(orgId, trigger);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
