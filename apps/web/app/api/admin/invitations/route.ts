import { NextResponse, type NextRequest } from "next/server";

import { invitationLink, type OrgInvitation } from "@/lib/admin/invitations";
import { sendInvitationEmail, type InviteEmailResult } from "@/lib/admin/invite-email";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

type CreateInvitationPayload = {
  email: string;
  orgName: string;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Admin surfaces are indistinguishable from absent routes for non-admins.
  // RLS on org_invitations enforces the same boundary at the database.
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  try {
    const payload = parseCreateInvitationPayload(await request.json());
    // A tenant invite for an email that already has an account can never be
    // consumed (the provisioning trigger only fires for new auth users), so
    // refuse it up front instead of leaving a forever-pending row.
    const { data: accountState, error: stateError } = await supabase.rpc(
      "invitee_account_state",
      { target_org_id: null, target_email: payload.email }
    );
    if (stateError) {
      return carryAuthCookies(
        response,
        NextResponse.json({ error: stateError.message }, { status: 500 })
      );
    }
    if (accountState !== "none") {
      return carryAuthCookies(
        response,
        NextResponse.json(
          {
            error:
              "That email already has an account. Add them from the site admin page instead."
          },
          { status: 422 }
        )
      );
    }
    const { data, error } = await supabase
      .from("org_invitations")
      .insert({ email: payload.email, org_name: payload.orgName })
      .select("*")
      .single();
    if (error) {
      const isDuplicate = error.code === "23505";
      return carryAuthCookies(
        response,
        NextResponse.json(
          {
            error: isDuplicate
              ? `A live invitation for ${payload.email} already exists.`
              : error.message
          },
          { status: isDuplicate ? 409 : 500 }
        )
      );
    }
    const invitation = data as OrgInvitation;
    // Best-effort email with the invite link; the panel's copy-link action is
    // the fallback, so a delivery failure is reported, not fatal.
    const email: InviteEmailResult = await sendInvitationEmail({
      to: invitation.email,
      orgName: payload.orgName,
      inviteUrl: invitationLink(request.nextUrl.origin, invitation.token)
    });
    return carryAuthCookies(response, NextResponse.json({ invitation, email }, { status: 201 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid invitation request.";
    return carryAuthCookies(response, NextResponse.json({ error: message }, { status: 400 }));
  }
}

function parseCreateInvitationPayload(value: unknown): CreateInvitationPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invitation request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const email = payload.email;
  const orgName = payload.orgName;
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("Invitation request must include a valid email.");
  }
  if (typeof orgName !== "string" || orgName.trim().length === 0) {
    throw new Error("Invitation request must include an organization name.");
  }
  return { email: email.trim().toLowerCase(), orgName: orgName.trim() };
}
