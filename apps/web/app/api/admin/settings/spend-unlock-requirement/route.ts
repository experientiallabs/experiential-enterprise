import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Set what unlocks platform-credit spending for a locked org: 'email' (the
 * founding admin proves inbox ownership) or 'card' (a saved Stripe payment
 * method). Only the CONDITION that sets organizations.spend_unlocked_at changes;
 * the P1025 spend gate is untouched. Platform-admin surface.
 */
export async function PUT(request: NextRequest): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as { requirement?: unknown } | null;
    if (body?.requirement !== "email" && body?.requirement !== "card") {
      return NextResponse.json(
        { error: "requirement must be 'email' or 'card'." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      await getDataSource().putSpendUnlockRequirement(body.requirement)
    );
  } catch (error) {
    return jsonError(error);
  }
}
