import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Set the YC launch grant amount (micro-USD, total with the welcome promo folded
 * in). Returns the consolidated credit-gating settings. Platform-admin surface.
 */
export async function PUT(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as { micro_usd?: unknown } | null;
    if (!Number.isInteger(body?.micro_usd) || (body?.micro_usd as number) < 0) {
      return NextResponse.json(
        { error: "micro_usd must be a nonnegative integer." },
        { status: 400 }
      );
    }
    return NextResponse.json(await getDataSource().putYcGrant(body!.micro_usd as number));
  } catch (error) {
    return jsonError(error);
  }
}
