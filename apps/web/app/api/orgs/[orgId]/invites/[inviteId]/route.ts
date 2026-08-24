import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; inviteId: string }>;
};

/**
 * Revoke one of this organization's pending invites. Org-admin gated; the
 * org_id filter keeps the reach inside the caller's organization even for
 * a guessed invite id.
 */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, inviteId } = await context.params;
    const user = await requireAuthenticatedUser();
    const orgId = await requireOrgId(orgIdentifier);
    const platformAdmin = await isPlatformAdmin();
    const canManage = platformAdmin || (await isOrgAdmin(user.id, orgId));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin
      .from("org_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId)
      .eq("org_id", orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Invite not found." }, { status: 404 });
    }
    await recordAuditEvent(admin, {
      orgId,
      actorKind: platformAdmin ? "platform_admin" : "user",
      actorId: user.id,
      action: "invites.revoke",
      objectType: "invite",
      objectId: inviteId
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
