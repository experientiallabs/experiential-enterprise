import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Grant credits to (or adjust) one organization. Replaces the usage-limit
 * editor: the backend appends a ledger entry, so every support action leaves
 * an auditable row. Platform-admin surface; the backend enforces the same
 * gate on its side.
 */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId } = await context.params;
    const body = (await request.json().catch(() => null)) as {
      amount_usd?: unknown;
      reason?: unknown;
    } | null;
    const amount = body?.amount_usd;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0) {
      return NextResponse.json(
        { error: "amount_usd must be a non-zero number (negative adjusts credit down)." },
        { status: 400 }
      );
    }
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason : undefined;
    const result = await getDataSource().postAdminCreditGrant(orgId, {
      amount_usd: amount,
      reason
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
