import { NextResponse, type NextRequest } from "next/server";

import { INVITE_ROLES } from "@/lib/admin/invites";
import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError } from "@/lib/http";
import { isLastOrgAdmin } from "@/lib/members/manage";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; userId: string }>;
};

/**
 * Change one membership's role within this organization. Unlike the
 * experiential-admin surface there is no cross-org move here, and the last
 * admin cannot demote themselves: an org must keep at least one admin.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, userId } = await context.params;
    const gate = await requireOrgManager(orgIdentifier);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
    const role = body?.role;
    if (typeof role !== "string" || !INVITE_ROLES.includes(role as never)) {
      return NextResponse.json(
        { error: `role must be one of: ${INVITE_ROLES.join(", ")}.` },
        { status: 400 }
      );
    }
    const admin = createServiceRoleSupabaseClient();
    if (role !== "admin" && (await isLastOrgAdmin(admin, gate.orgId, userId))) {
      return NextResponse.json(
        { error: "The organization needs at least one admin." },
        { status: 409 }
      );
    }
    const { data, error } = await admin
      .from("organization_members")
      .update({ role })
      .eq("org_id", gate.orgId)
      .eq("user_id", userId)
      .select("org_id, user_id, role");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Membership not found." }, { status: 404 });
    }
    await recordAuditEvent(admin, {
      orgId: gate.orgId,
      actorKind: gate.platformAdmin ? "platform_admin" : "user",
      actorId: gate.actorId,
      action: "members.role_set",
      objectType: "member",
      objectId: userId,
      after: { role }
    });
    return NextResponse.json({ membership: data[0] });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Remove one member from this organization. Their account survives, as do
 * their other org memberships; the last admin cannot be removed.
 */
export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier, userId } = await context.params;
    const gate = await requireOrgManager(orgIdentifier);
    if (gate instanceof NextResponse) {
      return gate;
    }
    const admin = createServiceRoleSupabaseClient();
    if (await isLastOrgAdmin(admin, gate.orgId, userId)) {
      return NextResponse.json(
        { error: "The organization needs at least one admin." },
        { status: 409 }
      );
    }
    const { data, error } = await admin
      .from("organization_members")
      .delete()
      .eq("org_id", gate.orgId)
      .eq("user_id", userId)
      .select("user_id");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Membership not found." }, { status: 404 });
    }
    await recordAuditEvent(admin, {
      orgId: gate.orgId,
      actorKind: gate.platformAdmin ? "platform_admin" : "user",
      actorId: gate.actorId,
      action: "members.remove",
      objectType: "member",
      objectId: userId
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}

/** Resolve the org and require org-admin (or experiential-admin) rights. */
async function requireOrgManager(
  orgIdentifier: string
): Promise<NextResponse | { orgId: string; actorId: string; platformAdmin: boolean }> {
  const user = await requireAuthenticatedUser();
  const orgId = await requireOrgId(orgIdentifier);
  const platformAdmin = await isPlatformAdmin();
  const canManage = platformAdmin || (await isOrgAdmin(user.id, orgId));
  if (!canManage) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return { orgId, actorId: user.id, platformAdmin };
}
