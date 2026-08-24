import { NextResponse } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Read the consolidated platform-wide credit/spend-unlock settings: the welcome
 * and YC grant amounts, the pre-verify spend allowance, and the spend-unlock
 * requirement mode. Backs the admin Platform panel. Platform-admin surface; a
 * non-admin gets the standard not-found.
 */
export async function GET(): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(await getDataSource().getCreditGating());
  } catch (error) {
    return jsonError(error);
  }
}
