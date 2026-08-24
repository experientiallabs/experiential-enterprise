import { NextResponse, type NextRequest } from "next/server";

import { INVITE_ROLES } from "@/lib/admin/invites";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string; userId: string }>;
};

const ASSIGNABLE_ROLES = INVITE_ROLES;

type MembershipUpdate = {
  targetOrgId: string | null;
  role: string | null;
};

// Moves a membership to another organization and/or changes its role. A
// single UPDATE (primary-key columns included) keeps the reassignment atomic:
// the member is never left without a membership half-way.
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { orgId, userId } = await context.params;
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  try {
    const update = parseMembershipUpdate(await request.json());
    if (update.targetOrgId === null && update.role === null) {
      return carryAuthCookies(
        response,
        NextResponse.json({ error: "Nothing to update." }, { status: 400 })
      );
    }
    const patch: Record<string, string> = {};
    if (update.targetOrgId !== null) {
      patch.org_id = update.targetOrgId;
    }
    if (update.role !== null) {
      patch.role = update.role;
    }
    const { data, error } = await supabase
      .from("organization_members")
      .update(patch)
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .select("org_id, user_id, role");
    if (error) {
      const isDuplicate = error.code === "23505";
      return carryAuthCookies(
        response,
        NextResponse.json(
          {
            error: isDuplicate
              ? "That user is already a member of the target organization."
              : error.message
          },
          { status: isDuplicate ? 409 : 500 }
        )
      );
    }
    if (!data || data.length === 0) {
      return carryAuthCookies(
        response,
        NextResponse.json({ error: "Membership not found." }, { status: 404 })
      );
    }
    return carryAuthCookies(response, NextResponse.json({ membership: data[0] }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid membership request.";
    return carryAuthCookies(response, NextResponse.json({ error: message }, { status: 400 }));
  }
}

// Removes a member from an organization. The auth user survives; a user with
// no remaining memberships can sign in but reaches no tenant data.
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { orgId, userId } = await context.params;
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  const { data, error } = await supabase
    .from("organization_members")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) {
    return carryAuthCookies(response, NextResponse.json({ error: error.message }, { status: 500 }));
  }
  if (!data || data.length === 0) {
    return carryAuthCookies(
      response,
      NextResponse.json({ error: "Membership not found." }, { status: 404 })
    );
  }
  return carryAuthCookies(response, new NextResponse(null, { status: 204 }));
}

function parseMembershipUpdate(value: unknown): MembershipUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Membership request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const targetOrgId = payload.targetOrgId;
  const role = payload.role;
  if (targetOrgId !== undefined && targetOrgId !== null && typeof targetOrgId !== "string") {
    throw new Error("targetOrgId must be an organization id.");
  }
  if (role !== undefined && role !== null) {
    if (typeof role !== "string" || !ASSIGNABLE_ROLES.includes(role as never)) {
      throw new Error(`role must be one of: ${ASSIGNABLE_ROLES.join(", ")}.`);
    }
  }
  return {
    targetOrgId: typeof targetOrgId === "string" && targetOrgId.length > 0 ? targetOrgId : null,
    role: typeof role === "string" ? role : null
  };
}
