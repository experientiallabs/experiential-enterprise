import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { jsonError, jsonOk, routeParams } from "@/lib/http";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ inviteId: string }>;
};

export async function DELETE(_request: NextRequest, context: Context): Promise<Response> {
  try {
    const { inviteId } = await routeParams(context.params);
    await requireAuthenticatedUser();

    // The RLS select policy only exposes invites of orgs the caller
    // administers, so visibility doubles as the authorization check.
    const supabase = await createServerSupabaseClient();
    const { data: invite, error } = await supabase
      .from("org_invitations")
      .select("id, accepted_at")
      .eq("id", inviteId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!invite) {
      return NextResponse.json({ error: "Invite not found." }, { status: 404 });
    }
    if (invite.accepted_at) {
      return NextResponse.json(
        { error: "This invite already provisioned an account and cannot be revoked." },
        { status: 409 }
      );
    }

    const admin = createServiceRoleSupabaseClient();
    const { error: deleteError } = await admin
      .from("org_invitations")
      .delete()
      .eq("id", inviteId)
      .is("accepted_at", null);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    return jsonOk({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
