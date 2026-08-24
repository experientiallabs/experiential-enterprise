import { NextResponse, type NextRequest } from "next/server";

import { bearerMatchesCronSecret } from "@/lib/auth/cron";
import { getInternalDataSource } from "@/lib/data-source";

export const dynamic = "force-dynamic";

/**
 * The pg_cron balance sweep: refresh stale provider spend readings and re-fetch
 * tool-account balances across every org, returning the backend's run summary.
 * Gated by Bearer CRON_SECRET; a bad bearer answers the admin convention's
 * not-found so the route's existence is not probeable. Re-running is safe by
 * construction (the backend enforces per-account staleness floors).
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!bearerMatchesCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const summary = await getInternalDataSource().runScheduledBalanceFetch();
  return NextResponse.json(summary);
}
