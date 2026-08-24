import { NextResponse, type NextRequest } from "next/server";

import { bearerMatchesCronSecret } from "@/lib/auth/cron";
import { getInternalDataSource } from "@/lib/data-source";

export const dynamic = "force-dynamic";

/**
 * Scheduled captured-prompt broadcast (pg_cron -> here -> backend). Drains
 * the queue of opt-in captured prompts to each org's explicitly enabled
 * destinations; orgs without one keep the platform table as their store of
 * record. CRON_SECRET-gated and 404 fail-closed, like every internal tick.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!bearerMatchesCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const summary = await getInternalDataSource().runBroadcast();
  return NextResponse.json(summary);
}
