import { NextResponse } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";

export const dynamic = "force-dynamic";

// Returns every org's priced spend and budget in one response for the admin
// Organizations panel. The panel polls this after render, and the
// backend computes it with a constant number of table scans, so neither the
// page nor the backend does per-tenant usage work. Platform-admin surface:
// non-admins see the standard not-found.
export async function GET(): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const usage = await getDataSource().getPlatformOrgUsage();
    // The admin panel is a live spend surface; never let browser/proxy caches
    // stretch its three-second poll cadence into a stale minute.
    return NextResponse.json(usage, {
      headers: { "cache-control": "private, no-store" }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load organization usage.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
