import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Self-service account deletion. Deletes the auth user; the auth.users
 * cleanup trigger removes memberships and per-user state in the same
 * transaction. Deliberately narrower than "delete all data": organizations
 * and their product data survive (an org you leave behind stays for its
 * other members, or for the operator to reap).
 *
 * Guards, both 409s the UI explains:
 * - the last admin of an org that still has other members must hand off
 *   admin first, so the org is never stranded without one;
 * - the only experiential admin cannot remove themselves, so the deployment
 *   always keeps an operator.
 */
export async function DELETE(_request: NextRequest): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const admin = createServiceRoleSupabaseClient();

    const [{ data: adminRows, error: adminError }, { data: platformRows, error: platformError }] =
      await Promise.all([
        admin.from("organization_members").select("org_id").eq("user_id", user.id).eq("role", "admin"),
        admin.from("platform_admins").select("user_id")
      ]);
    if (adminError) {
      return NextResponse.json({ error: adminError.message }, { status: 500 });
    }
    if (platformError) {
      return NextResponse.json({ error: platformError.message }, { status: 500 });
    }

    const platformAdminIds = ((platformRows ?? []) as Array<{ user_id: string }>).map(
      (row) => row.user_id
    );
    if (platformAdminIds.length === 1 && platformAdminIds[0] === user.id) {
      return NextResponse.json(
        { error: "You are the only experiential admin; grant another before deleting." },
        { status: 409 }
      );
    }

    const adminOrgIds = ((adminRows ?? []) as Array<{ org_id: string }>).map((row) => row.org_id);
    for (const orgId of adminOrgIds) {
      const [{ count: memberCount, error: memberError }, { count: adminCount, error: countError }] =
        await Promise.all([
          admin
            .from("organization_members")
            .select("user_id", { count: "exact", head: true })
            .eq("org_id", orgId),
          admin
            .from("organization_members")
            .select("user_id", { count: "exact", head: true })
            .eq("org_id", orgId)
            .eq("role", "admin")
        ]);
      if (memberError || countError) {
        return NextResponse.json(
          { error: (memberError ?? countError)?.message ?? "Membership check failed." },
          { status: 500 }
        );
      }
      if ((memberCount ?? 0) > 1 && (adminCount ?? 0) === 1) {
        return NextResponse.json(
          {
            error:
              "You are the only admin of an organization with other members. Make someone else an admin first."
          },
          { status: 409 }
        );
      }
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return jsonError(error);
  }
}
