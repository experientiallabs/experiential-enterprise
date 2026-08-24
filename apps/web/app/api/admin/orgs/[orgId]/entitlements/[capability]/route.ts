import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { getDataSource } from "@/lib/data-source";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; capability: string }>;
};

/**
 * Grant one enterprise capability to one org (optionally time-bound with an
 * ISO expiry and a note). This is how a paying enterprise account gets the
 * /ee surfaces on the hosted platform; every other org stays unlicensed.
 */
export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId, capability } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      note?: unknown;
      expiresAt?: unknown;
    };
    const note = typeof body.note === "string" && body.note.length > 0 ? body.note : null;
    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt.length > 0 ? body.expiresAt : null;
    return NextResponse.json(
      await getDataSource().grantOrgEntitlement(orgId, capability, { note, expiresAt })
    );
  } catch (error) {
    return jsonError(error);
  }
}

/** Revoke one capability grant; the org's enterprise surface goes absent. */
export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { orgId, capability } = await context.params;
    return NextResponse.json(await getDataSource().revokeOrgEntitlement(orgId, capability));
  } catch (error) {
    return jsonError(error);
  }
}
