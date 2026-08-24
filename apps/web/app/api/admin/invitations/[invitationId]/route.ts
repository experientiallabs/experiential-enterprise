import { NextResponse, type NextRequest } from "next/server";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ invitationId: string }>;
};

// Revokes an invitation. Accepted invitations stay immutable history; only a
// live (pending or expired) invite can be revoked.
export async function DELETE(request: NextRequest, context: Context): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { invitationId } = await context.params;
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  const { data, error } = await supabase
    .from("org_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    return carryAuthCookies(response, NextResponse.json({ error: error.message }, { status: 500 }));
  }
  if (!data || data.length === 0) {
    return carryAuthCookies(
      response,
      NextResponse.json({ error: `No revocable invitation found: ${invitationId}` }, { status: 404 })
    );
  }
  return carryAuthCookies(response, new NextResponse(null, { status: 204 }));
}
