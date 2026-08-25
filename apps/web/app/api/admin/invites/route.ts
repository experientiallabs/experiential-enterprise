import { NextResponse, type NextRequest } from "next/server";

import { invitationLink } from "@/lib/admin/invitations";
import { sendOrgInviteEmail, type InviteEmailResult } from "@/lib/admin/invite-email";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requestOrigin } from "@/lib/auth/redirects";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { parseInvitePayload } from "@/lib/admin/invites";
import { jsonError, jsonOk } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    const payload = parseInvitePayload(await request.json());
    // Platform admins administer every org — including ones they just
    // created and are not members of.
    if (!(await isOrgAdmin(user.id, payload.orgId)) && !(await isPlatformAdmin())) {
      return NextResponse.json(
        { error: "Only organization admins can send invites." },
        { status: 403 }
      );
    }

    const admin = createServiceRoleSupabaseClient();
    // An expired invite still holds the one-pending-per-(org,email) slot;
    // re-inviting replaces it rather than 409ing forever. Surface a cleanup
    // failure directly — otherwise the insert below 409s with a misleading
    // "already pending" for an invite that has actually expired.
    const { error: cleanupError } = await admin
      .from("org_invitations")
      .delete()
      .eq("org_id", payload.orgId)
      .eq("email", payload.email)
      .is("accepted_at", null)
      .lte("expires_at", new Date().toISOString());
    if (cleanupError) {
      return NextResponse.json({ error: cleanupError.message }, { status: 500 });
    }

    // Refuse invites that can never work: an existing member is a mistake,
    // and an email with an existing account can never consume an invite (the
    // provisioning trigger only fires when a new auth user is created).
    const { data: accountState, error: stateError } = await admin.rpc("invitee_account_state", {
      target_org_id: payload.orgId,
      target_email: payload.email
    });
    if (stateError) {
      return NextResponse.json({ error: stateError.message }, { status: 500 });
    }
    if (accountState === "member") {
      return NextResponse.json(
        { error: "That email already belongs to a member of the organization." },
        { status: 409 }
      );
    }
    if (accountState === "user") {
      return NextResponse.json(
        {
          error:
            "That email already has an account. A platform admin can add them from the site admin page."
        },
        { status: 422 }
      );
    }

    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("name, banned_at")
      .eq("id", payload.orgId)
      .single();
    if (orgError) {
      return NextResponse.json({ error: orgError.message }, { status: 500 });
    }
    // A banned org may not grow; the ban already revoked its pending invites.
    if (org.banned_at != null) {
      return NextResponse.json(
        { error: "This organization is banned. Members cannot be added or invited." },
        { status: 403 }
      );
    }

    const { data: invite, error: insertError } = await admin
      .from("org_invitations")
      .insert({
        org_id: payload.orgId,
        email: payload.email,
        role: payload.role,
        invited_by: user.id
      })
      .select("id, token")
      .single();
    if (insertError) {
      if (insertError.code === "23505") {
        return NextResponse.json(
          { error: "An invite for this email is already pending in that organization." },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // The invitee accepts through the platform's own tokened signup link; the
    // provisioning trigger grants the membership on their actual signup
    // (password or OAuth). GoTrue invites are deliberately not used: they
    // create the auth user at send time — instantly consuming the invite —
    // and their emails leave from Supabase's sender with a Site-URL redirect
    // instead of this deployment's origin.
    const email: InviteEmailResult = await sendOrgInviteEmail({
      to: payload.email,
      orgName: org.name,
      role: payload.role,
      inviteUrl: invitationLink(requestOrigin(request), invite.token)
    });

    return jsonOk({ ok: true, id: invite.id, email });
  } catch (error) {
    return jsonError(error);
  }
}
