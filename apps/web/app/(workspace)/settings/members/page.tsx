import { MembersPanel } from "@/components/settings/MembersPanel";
import { createServiceRoleSupabaseClient, isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { resolveActiveOrg } from "@/lib/active-org";
import { createServerSupabaseClient, requireAuthenticatedUser } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import { listOrgPendingInvites, listOrgRoster } from "@/lib/members/manage";
import type { PendingJoinRequest } from "@/lib/org-join/types";

export const metadata = { title: "Members" };

export const dynamic = "force-dynamic";

/**
 * Who is in this organization. Every member sees the roster; org admins
 * invite, change roles, and remove. Experiential admins pass the same gate.
 */
export default async function MembersSettingsPage() {
  // Settings is workspace-private (main's proxy bounces signed-out to /signin).
  const user = await requireAuthenticatedUser();
  const org = await resolveActiveOrg();
  const supabase = await createServerSupabaseClient();
  const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));
  const [members, invites, joinRequests] = await Promise.all([
    listOrgRoster(supabase, org.id),
    canManage ? listOrgPendingInvites(createServiceRoleSupabaseClient(), org.id) : [],
    canManage ? loadJoinRequests(org.id) : []
  ]);

  return (
    <MembersPanel
      canManage={canManage}
      currentUserId={user.id}
      invites={invites}
      joinRequests={joinRequests}
      members={members}
      orgId={org.id}
    />
  );
}

/**
 * Pending domain-based access requests for this org. Fails open to an empty
 * list so a backend hiccup never blocks the roster an admin came to manage.
 */
async function loadJoinRequests(orgId: string): Promise<PendingJoinRequest[]> {
  try {
    return (await getDataSource().listJoinRequests(orgId)).requests;
  } catch {
    return [];
  }
}
