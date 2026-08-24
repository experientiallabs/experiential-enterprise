import { signinPath } from "@/lib/routes";

// Row shape of public.org_invitations as the admin panel consumes it. All
// reads and writes go through the signed-in user's RLS-scoped client; only
// platform admins hold a policy on the table.
export type OrgInvitation = {
  id: string;
  email: string;
  token: string;
  org_id: string | null;
  role: string;
  org_name: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export function invitationStatus(invitation: OrgInvitation, now: Date = new Date()): InvitationStatus {
  if (invitation.accepted_at !== null) {
    return "accepted";
  }
  if (invitation.revoked_at !== null) {
    return "revoked";
  }
  if (new Date(invitation.expires_at).getTime() <= now.getTime()) {
    return "expired";
  }
  return "pending";
}

export function invitationLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}${signinPath()}?invite=${encodeURIComponent(token)}`;
}
