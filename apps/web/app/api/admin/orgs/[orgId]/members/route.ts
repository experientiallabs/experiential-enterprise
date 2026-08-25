import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { requestOrigin } from "@/lib/auth/redirects";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { addOrInviteMember, parseMemberPayload } from "@/lib/members/manage";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Add one person to any organization without making the operator choose a
 * separate flow. Existing accounts receive a membership immediately; new
 * people receive the same tokened signup invite used by provisioning. The
 * flow itself is shared with the org-scoped members route; this wrapper is
 * the experiential-admin variant (any org, memberless orgs included, so the
 * org lookup runs on the service role rather than membership-scoped RLS).
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [{ orgId }, actor] = await Promise.all([context.params, requireAuthenticatedUser()]);
  try {
    const payload = parseMemberPayload(await request.json());
    const admin = createServiceRoleSupabaseClient();
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    if (orgError) {
      return NextResponse.json({ error: orgError.message }, { status: 500 });
    }
    if (!org) {
      return NextResponse.json({ error: `Organization not found: ${orgId}` }, { status: 404 });
    }
    const result = await addOrInviteMember(admin, {
      orgId,
      orgName: org.name,
      email: payload.email,
      role: payload.role,
      invitedBy: actor.id,
      origin: requestOrigin(request)
    });
    if (result.action === "error") {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }
    if (result.action === "invited") {
      await recordAuditEvent(admin, {
        orgId,
        actorKind: "platform_admin",
        actorId: actor.id,
        action: "invites.create",
        objectType: "invite",
        objectId: result.invitationId,
        after: { email: payload.email, role: result.role }
      });
    }
    const { status, ...body } = result;
    return NextResponse.json(body, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid member request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
