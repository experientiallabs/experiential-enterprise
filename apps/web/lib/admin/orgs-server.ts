import type { WelcomeTriggerView } from "@/lib/backend-source";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import type { OrgPendingInvite, OrgRosterMember } from "@/lib/members/manage";

// Server-only loader for the experiential-admin page. Organizations come
// straight through RLS (experiential admins hold a select-all policy); the
// member roster joins auth emails through the admin-gated definer RPC, and
// pending join invites ride along so the panel's shared MembersPanel can
// render them per org.

export type AdministeredOrgBan = {
  reason: string;
  bannedBy: string | null;
  bannedByEmail: string | null;
  bannedAt: string;
};

export type AdministeredMember = OrgRosterMember & {
  /**
   * Whether the account holds a live USER ban. Only the org DETAIL loader
   * carries it (a narrow user_bans read for the shared account actions); the
   * roster loaders skip it because the browse/insights surfaces never render
   * it. Distinct from the org-level ban on AdministeredOrg.
   */
  banned: boolean;
};

export type AdministeredOrg = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  /** Usage budget in USD; null means unlimited. */
  members: OrgRosterMember[];
  invites: OrgPendingInvite[];
  /** The active org ban record; null means the tenant is in good standing. */
  ban: AdministeredOrgBan | null;
};

/**
 * The detail-page shape: the same org with user-ban state on each member, plus
 * the org's persisted welcome-celebration trigger (null when never armed) so the
 * admin card seeds from real state rather than fabricated defaults.
 */
export type AdministeredOrgDetail = Omit<AdministeredOrg, "members"> & {
  members: AdministeredMember[];
  welcomeTrigger: WelcomeTriggerView | null;
};

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};
type MemberRow = {
  org_id: string;
  user_id: string;
  email: string | null;
  role: string;
  created_at: string;
};
type InviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
};
type OrgBanRow = {
  org_id: string;
  reason: string;
  banned_by: string | null;
  banned_by_email: string | null;
  banned_at: string;
};

export type AdministeredOrgName = { id: string; name: string };

/**
 * The id → name roster for admin surfaces that only label organizations
 * (the Telemetry panel's breakdown): one RLS-scoped select, none of the
 * member/invite/admin joins the full loader pays for.
 */
export async function listAdministeredOrgNames(): Promise<AdministeredOrgName[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("organizations").select("id, name").order("name");
  if (error) {
    throw new Error(`Unable to list organizations: ${error.message}`);
  }
  return (data ?? []) as AdministeredOrgName[];
}

export async function listAdministeredOrgs(): Promise<AdministeredOrg[]> {
  const supabase = await createServerSupabaseClient();
  const [orgsResult, membersResult, siteAdminsResult, invitesResult, bansResult] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, slug, created_at")
      .order("created_at"),
    supabase.rpc("admin_list_org_members"),
    // Experiential admins hold a select-all policy on platform_admins, so the
    // roster resolves under the viewer's own RLS session.
    supabase.from("platform_admins").select("user_id"),
    // Join invites only (org_id set): pending, unrevoked, unexpired.
    supabase
      .from("org_invitations")
      .select("id, org_id, email, role, created_at, expires_at")
      .not("org_id", "is", null)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
    // Ban records with the banning operator's email joined (definer RPC, like
    // admin_list_users); the panel badges and the detail page read this.
    supabase.rpc("admin_list_org_bans")
  ]);
  if (orgsResult.error) {
    throw new Error(`Unable to list organizations: ${orgsResult.error.message}`);
  }
  if (membersResult.error) {
    throw new Error(`Unable to list organization members: ${membersResult.error.message}`);
  }
  if (siteAdminsResult.error) {
    throw new Error(`Unable to list experiential admins: ${siteAdminsResult.error.message}`);
  }
  if (invitesResult.error) {
    throw new Error(`Unable to list invites: ${invitesResult.error.message}`);
  }
  if (bansResult.error) {
    throw new Error(`Unable to list organization bans: ${bansResult.error.message}`);
  }
  const siteAdminIds = new Set(
    ((siteAdminsResult.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id)
  );
  const membersByOrg = new Map<string, OrgRosterMember[]>();
  for (const row of (membersResult.data ?? []) as MemberRow[]) {
    const members = membersByOrg.get(row.org_id) ?? [];
    members.push({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      isExperientialAdmin: siteAdminIds.has(row.user_id)
    });
    membersByOrg.set(row.org_id, members);
  }
  const invitesByOrg = new Map<string, OrgPendingInvite[]>();
  for (const row of (invitesResult.data ?? []) as InviteRow[]) {
    const invites = invitesByOrg.get(row.org_id) ?? [];
    invites.push({
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    });
    invitesByOrg.set(row.org_id, invites);
  }
  const banByOrg = new Map<string, AdministeredOrgBan>();
  for (const row of (bansResult.data ?? []) as OrgBanRow[]) {
    banByOrg.set(row.org_id, {
      reason: row.reason,
      bannedBy: row.banned_by,
      bannedByEmail: row.banned_by_email,
      bannedAt: row.banned_at
    });
  }
  return ((orgsResult.data ?? []) as OrgRow[]).map((org) => ({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.created_at,
    members: membersByOrg.get(org.id) ?? [],
    invites: invitesByOrg.get(org.id) ?? [],
    ban: banByOrg.get(org.id) ?? null
  }));
}

/**
 * One organization's full admin record for the detail page. Reuses the
 * all-orgs loader (the member RPC and invite read are unfiltered anyway),
 * selects the requested tenant, and joins USER-ban state for the shared
 * per-user account actions through a NARROW user_bans read scoped to this
 * org's members (platform admins hold a select policy on user_bans) — the
 * roster loaders deliberately skip it, so the admin home and insights pages
 * never pay for or depend on it. The ORG-level ban rides in from the roster
 * loader unchanged. Returns null when no such org is visible so the detail
 * route can render a not-found instead of throwing.
 */
export async function getAdministeredOrg(orgId: string): Promise<AdministeredOrgDetail | null> {
  const orgs = await listAdministeredOrgs();
  const org = orgs.find((candidate) => candidate.id === orgId) ?? null;
  if (org === null) {
    return null;
  }
  const memberIds = org.members.map((member) => member.userId);
  const bannedIds = new Set<string>();
  if (memberIds.length > 0) {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("user_bans")
      .select("user_id")
      .in("user_id", memberIds);
    if (error) {
      throw new Error(`Unable to read ban state: ${error.message}`);
    }
    for (const row of (data ?? []) as Array<{ user_id: string }>) {
      bannedIds.add(row.user_id);
    }
  }
  // The welcome trigger lives behind a member-scoped RLS policy, so a platform
  // admin viewing another org reads it through the backend (service role).
  const { trigger } = await getDataSource().getAdminWelcomeTrigger(orgId);
  return {
    ...org,
    members: org.members.map((member) => ({ ...member, banned: bannedIds.has(member.userId) })),
    welcomeTrigger: trigger
  };
}
