import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Turn the pre-verify spend allowance ON ($1) or OFF (0 = email verification
 * required for all credits). The gateway spend gate reads the resulting value.
 * Returns the consolidated credit-gating settings. Platform-admin surface.
 */
export async function PUT(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean (true = $1 before verifying, false = verify first)." },
        { status: 400 }
      );
    }
    return NextResponse.json(await getDataSource().putPreVerifyAllowance(body.enabled));
  } catch (error) {
    return jsonError(error);
  }
}
