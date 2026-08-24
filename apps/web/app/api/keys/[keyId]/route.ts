import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ keyId: string }>;
};

// Revoke an API key. The row stays as history; the backend stops accepting
// the key on its next lookup.
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const { keyId } = await context.params;

    // Resolve the key through the caller's RLS-scoped client: another org's
    // key is invisible there, so a guessed foreign id 404s exactly like an
    // absent one instead of leaking existence via 403. Platform admins read
    // through the service role instead — api_keys rows are only RLS-visible
    // via membership, and admins manage keys in memberless orgs too.
    const platformAdmin = await isPlatformAdmin();
    const reader = platformAdmin
      ? createServiceRoleSupabaseClient()
      : await createServerSupabaseClient();
    const { data: apiKey, error: readError } = await reader
      .from("api_keys")
      .select("id, org_id, revoked_at")
      .eq("id", keyId)
      .maybeSingle();
    if (readError) {
      return NextResponse.json({ error: readError.message }, { status: 500 });
    }
    if (!apiKey) {
      return NextResponse.json({ error: `API key not found: ${keyId}` }, { status: 404 });
    }
    if (!platformAdmin && !(await isOrgAdmin(user.id, apiKey.org_id))) {
      return NextResponse.json(
        { error: "Only organization admins can manage API keys." },
        { status: 403 }
      );
    }
    if (apiKey.revoked_at !== null) {
      return NextResponse.json({ error: "API key is already revoked." }, { status: 409 });
    }

    const admin = createServiceRoleSupabaseClient();
    const revokedAt = new Date().toISOString();
    const { error: revokeError } = await admin
      .from("api_keys")
      .update({ revoked_at: revokedAt, revoked_by: user.id })
      .eq("id", keyId);
    if (revokeError) {
      return NextResponse.json({ error: revokeError.message }, { status: 500 });
    }
    await recordAuditEvent(admin, {
      orgId: apiKey.org_id,
      actorKind: platformAdmin ? "platform_admin" : "user",
      actorId: user.id,
      action: "keys.revoke",
      objectType: "api_key",
      objectId: keyId,
      after: { revoked_at: revokedAt }
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
