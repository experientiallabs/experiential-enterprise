import { NextResponse, type NextRequest } from "next/server";

import { revokeSuperadminKey } from "@/lib/admin/superadmin-keys";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

// Keys are addressed by their uuid PK; reject anything else up front so a
// malformed id gets the documented 404 instead of a PostgREST uuid-cast 500.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * Revoke a superadmin key: sets revoked_at (the table grants no delete), so
 * the key stops authenticating immediately while its row stays for audit.
 * Platform-admin surface; an unknown id is a 404.
 */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    if (!(await isPlatformAdmin())) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { id } = await context.params;
    if (!UUID_PATTERN.test(id)) {
      return NextResponse.json({ error: "No such key." }, { status: 404 });
    }
    const found = await revokeSuperadminKey(id);
    if (!found) {
      return NextResponse.json({ error: "No such key." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
