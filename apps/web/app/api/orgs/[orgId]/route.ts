import { NextResponse, type NextRequest } from "next/server";

import { recordAuditEvent } from "@/lib/audit";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireOrgId } from "@/lib/auth/orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { requireOrg } from "@/lib/data-cache";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_ORG_NAME_LENGTH = 80;

type Context = {
  params: Promise<{ orgId: string }>;
};

export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const { orgId } = await routeParams(context.params);
    const org = await requireOrg(orgId);
    return jsonOk({ org });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Rename the organization. Org-admin gated; only the display name changes.
 * The slug is the URL identity (D-SLUG-SCHEME) and stays immutable here.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId: orgIdentifier } = await routeParams(context.params);
    const user = await requireAuthenticatedUser();
    // The rename writes by id and echoes the updated row, so the full org record
    // (a backend org-list fetch) is never needed on this path.
    const orgId = await requireOrgId(orgIdentifier);
    const platformAdmin = await isPlatformAdmin();
    const canManage = platformAdmin || (await isOrgAdmin(user.id, orgId));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > MAX_ORG_NAME_LENGTH) {
      return NextResponse.json(
        { error: `name must be 1-${MAX_ORG_NAME_LENGTH} characters.` },
        { status: 400 }
      );
    }
    const admin = createServiceRoleSupabaseClient();
    // Read the outgoing name first so the audit event carries before/after;
    // a read failure only degrades the audit snapshot, never the rename.
    const previous = await admin
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    const { data, error } = await admin
      .from("organizations")
      .update({ name })
      .eq("id", orgId)
      .select("id, slug, name")
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    await recordAuditEvent(admin, {
      orgId,
      actorKind: platformAdmin ? "platform_admin" : "user",
      actorId: user.id,
      action: "org.rename",
      objectType: "organization",
      objectId: orgId,
      before: { name: previous.data?.name ?? null },
      after: { name: data.name }
    });
    return NextResponse.json({ org: data });
  } catch (error) {
    return jsonError(error);
  }
}
