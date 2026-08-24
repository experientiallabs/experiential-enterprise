// Server-only member management shared by the org Settings > Members section
// and the experiential-admin panel. One code path decides between "add the
// existing account now" and "create a tokened signup invite", so the two
// surfaces cannot drift on invite semantics (expired-slot cleanup, pending
// recovery, role realignment, email fallback).

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendOrgInviteEmail, type InviteEmailResult } from "@/lib/admin/invite-email";
import { invitationLink } from "@/lib/admin/invitations";
import { INVITE_ROLES } from "@/lib/admin/invites";

export type OrgMemberRole = (typeof INVITE_ROLES)[number];

export type OrgRosterMember = {
  userId: string;
  email: string | null;
  role: string;
  createdAt: string;
  isExperientialAdmin: boolean;
};

export type OrgPendingInvite = {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
};

export type AddMemberInput = {
  orgId: string;
  orgName: string;
  email: string;
  role: OrgMemberRole;
  invitedBy: string;
  origin: string;
};

export type AddMemberResult =
  | { action: "added"; status: number; membership: { org_id: string; user_id: string; role: string } }
  | {
      action: "invited";
      status: number;
      invitationId: string;
      role: string;
      email: InviteEmailResult;
      inviteUrl: string | null;
    }
  | { action: "error"; status: number; message: string };

export function parseMemberPayload(value: unknown): { email: string; role: OrgMemberRole } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Member request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const email = payload.email;
  const role = payload.role;
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("Member request must include a valid email.");
  }
  if (typeof role !== "string" || !INVITE_ROLES.includes(role as OrgMemberRole)) {
    throw new Error(`role must be one of: ${INVITE_ROLES.join(", ")}.`);
  }
  return { email: email.trim().toLowerCase(), role: role as OrgMemberRole };
}

/**
 * Add an existing account to the org immediately, or create (or recover) a
 * pending signup invite for a new person. `admin` must be the service-role
 * client; every caller gates on org admin or experiential admin first.
 */
export async function addOrInviteMember(
  admin: SupabaseClient,
  input: AddMemberInput
): Promise<AddMemberResult> {
  // A banned org may not grow: no immediate adds, no fresh invites. Guarded
  // here so the org Settings surface and the experiential-admin panel cannot
  // drift (the ban itself already revoked the org's pending invite tokens).
  const { data: orgRow, error: orgBanError } = await admin
    .from("organizations")
    .select("banned_at")
    .eq("id", input.orgId)
    .maybeSingle();
  if (orgBanError) {
    return { action: "error", status: 500, message: orgBanError.message };
  }
  if (orgRow?.banned_at != null) {
    return {
      action: "error",
      status: 403,
      message: "This organization is banned. Members cannot be added or invited."
    };
  }
  const { data: userId, error: lookupError } = await admin.rpc("admin_user_id_for_email", {
    target_email: input.email
  });
  if (lookupError) {
    return { action: "error", status: 500, message: lookupError.message };
  }
  if (typeof userId === "string" && userId.length > 0) {
    const { data, error } = await admin
      .from("organization_members")
      .insert({ org_id: input.orgId, user_id: userId, role: input.role })
      .select("org_id, user_id, role")
      .single();
    if (error) {
      const duplicate = error.code === "23505";
      return {
        action: "error",
        status: duplicate ? 409 : 500,
        message: duplicate ? "That account is already a member of the organization." : error.message
      };
    }
    return { action: "added", status: 201, membership: data };
  }

  // An expired invite still occupies the pending unique slot, so replace it
  // before creating a fresh invite for this organization and email.
  const { error: cleanupError } = await admin
    .from("org_invitations")
    .delete()
    .eq("org_id", input.orgId)
    .eq("email", input.email)
    .is("accepted_at", null)
    .lte("expires_at", new Date().toISOString());
  if (cleanupError) {
    return { action: "error", status: 500, message: cleanupError.message };
  }
  const now = new Date().toISOString();
  const loadPendingInvite = () =>
    admin
      .from("org_invitations")
      .select("id, token, role")
      .eq("org_id", input.orgId)
      .eq("email", input.email)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .maybeSingle();

  const pendingResult = await loadPendingInvite();
  if (pendingResult.error) {
    return { action: "error", status: 500, message: pendingResult.error.message };
  }
  let invite = pendingResult.data;
  let created = false;
  if (!invite) {
    const insertResult = await admin
      .from("org_invitations")
      .insert({
        org_id: input.orgId,
        email: input.email,
        role: input.role,
        invited_by: input.invitedBy
      })
      .select("id, token, role")
      .single();
    if (insertResult.error?.code === "23505") {
      // A concurrent request may have inserted the same live invite after
      // our read. Recover that row instead of stranding both operators on a
      // duplicate error with no link.
      const retryResult = await loadPendingInvite();
      if (retryResult.error) {
        return { action: "error", status: 500, message: retryResult.error.message };
      }
      invite = retryResult.data;
    } else if (insertResult.error) {
      return { action: "error", status: 500, message: insertResult.error.message };
    } else {
      invite = insertResult.data;
      created = true;
    }
  }
  if (!invite) {
    return {
      action: "error",
      status: 409,
      message: "The pending invite could not be recovered. Revoke it before retrying."
    };
  }
  // A recovered pending invite may still carry an older role from a failed
  // delivery attempt. Align it with the role the operator just selected so
  // retries cannot silently provision the previous role.
  if (!created && invite.role !== input.role) {
    const updateResult = await admin
      .from("org_invitations")
      .update({ role: input.role })
      .eq("id", invite.id)
      .select("id, token, role")
      .single();
    if (updateResult.error) {
      return { action: "error", status: 500, message: updateResult.error.message };
    }
    invite = updateResult.data;
  }
  const inviteUrl = invitationLink(input.origin, invite.token);
  const email: InviteEmailResult = await sendOrgInviteEmail({
    to: input.email,
    orgName: input.orgName,
    role: invite.role,
    inviteUrl
  });
  return {
    action: "invited",
    status: created ? 201 : 200,
    invitationId: invite.id,
    role: invite.role,
    email,
    // When delivery is unavailable, the flow must still leave the operator a
    // usable handoff instead of stranding the invite.
    inviteUrl: email.sent ? null : inviteUrl
  };
}

/** Roster with emails via the membership-gated definer RPC, admin flags joined. */
export async function listOrgRoster(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgRosterMember[]> {
  const [rosterResult, adminsResult] = await Promise.all([
    supabase.rpc("org_members_with_emails", { target_org_id: orgId }),
    // platform_admins lets a user select only their own row; experiential
    // admins see the roster. Either way the flag is correct for the viewer.
    supabase.from("platform_admins").select("user_id")
  ]);
  if (rosterResult.error) {
    throw new Error(`Unable to list members: ${rosterResult.error.message}`);
  }
  const adminIds = new Set(
    ((adminsResult.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id)
  );
  type RosterRow = { user_id: string; email: string | null; role: string; created_at: string };
  return ((rosterResult.data ?? []) as RosterRow[]).map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    isExperientialAdmin: adminIds.has(row.user_id)
  }));
}

/** Pending invites for one org; RLS restricts the read to that org's admins. */
export async function listOrgPendingInvites(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgPendingInvite[]> {
  const { data, error } = await supabase
    .from("org_invitations")
    .select("id, email, role, created_at, expires_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Unable to list invites: ${error.message}`);
  }
  type InviteRow = { id: string; email: string; role: string; created_at: string; expires_at: string };
  return ((data ?? []) as InviteRow[]).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));
}

/**
 * True when removing or demoting this member would leave the org without any
 * admin. Experiential admins are the recovery path for such orgs, but the
 * org-scoped surface refuses to create them.
 */
export async function isLastOrgAdmin(
  admin: SupabaseClient,
  orgId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("role", "admin");
  if (error) {
    throw new Error(`Unable to verify remaining admins: ${error.message}`);
  }
  const admins = (data ?? []).map((row) => String((row as { user_id: string }).user_id));
  return admins.length === 1 && admins[0] === userId;
}
