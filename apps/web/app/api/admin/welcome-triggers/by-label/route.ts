import { NextResponse } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Arm/disarm the welcome celebration for every org carrying a label (the cohort
 * lane — e.g. all `yc` orgs at once). Platform-admin surface; returns the
 * affected org count.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (label === "") {
      return NextResponse.json({ error: "label is required" }, { status: 400 });
    }
    const result = await getDataSource().postAdminWelcomeTriggerByLabel({
      label,
      active: body?.active === true,
      display_credit_usd:
        typeof body?.display_credit_usd === "number" ? body.display_credit_usd : null,
      show_api_key: body?.show_api_key !== false
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
