import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

// Deletes an organization through one definer transaction. Existing FKs
// remove the tenant graph; former members are removed from auth only when they
// have no membership elsewhere (platform operators are always preserved).
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { orgId } = await context.params;
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  const { data, error } = await supabase.rpc("admin_delete_organization", {
    target_org_id: orgId
  });
  if (error) {
    return carryAuthCookies(response, NextResponse.json({ error: error.message }, { status: 500 }));
  }
  if (!data || data.length === 0) {
    return carryAuthCookies(
      response,
      NextResponse.json({ error: `Organization not found: ${orgId}` }, { status: 404 })
    );
  }
  return carryAuthCookies(
    response,
    NextResponse.json({
      deletedOrganizationId: data[0].deleted_org_id,
      deletedUserCount: Number(data[0].deleted_user_count ?? 0)
    })
  );
}
