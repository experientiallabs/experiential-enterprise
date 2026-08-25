import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requestOrigin } from "@/lib/auth/redirects";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { requireOrg } from "@/lib/data-cache";
import { jsonError } from "@/lib/http";
import {
  addOrInviteMember,
  listOrgPendingInvites,
  listOrgRoster,
  parseMemberPayload
} from "@/lib/members/manage";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Org member roster. Every member sees who is in their organization; org
 * admins (and experiential admins) additionally see pending invites and get
 * `can_manage: true`. The definer RPC scopes the read to exactly this org,
 * so a multi-org member never sees another org's roster here.
 */
export async function GET(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await context.params;
    const user = await requireAuthenticatedUser();
    // The roster reads by id, so this path never needs the full org record.
    const orgId = await requireOrgId(orgIdentifier);
    const supabase = await createServerSupabaseClient();
    const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, orgId));
    const [members, invites] = await Promise.all([
      listOrgRoster(supabase, orgId),
      canManage ? listOrgPendingInvites(createServiceRoleSupabaseClient(), orgId) : []
    ]);
    return NextResponse.json({ members, invites, can_manage: canManage });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Add one person to the organization: existing accounts become members
 * immediately, new people receive a tokened signup invite. Org-admin gated;
 * same shared flow as the experiential-admin panel.
 */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId } = await context.params;
    const user = await requireAuthenticatedUser();
    const org = await requireOrg(orgId);
    const platformAdmin = await isPlatformAdmin();
    const canManage = platformAdmin || (await isOrgAdmin(user.id, org.id));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    let payload: { email: string; role: "admin" | "user" };
    try {
      payload = parseMemberPayload(await request.json());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid member request.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const admin = createServiceRoleSupabaseClient();
    const result = await addOrInviteMember(admin, {
      orgId: org.id,
      orgName: org.name,
      email: payload.email,
      role: payload.role,
      invitedBy: user.id,
      origin: requestOrigin(request)
    });
    if (result.action === "error") {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }
    if (result.action === "invited") {
      await recordAuditEvent(admin, {
        orgId: org.id,
        actorKind: platformAdmin ? "platform_admin" : "user",
        actorId: user.id,
        action: "invites.create",
        objectType: "invite",
        objectId: result.invitationId,
        after: { email: payload.email, role: result.role }
      });
    }
    const { status, ...body } = result;
    return NextResponse.json(body, { status });
  } catch (error) {
    return jsonError(error);
  }
}
