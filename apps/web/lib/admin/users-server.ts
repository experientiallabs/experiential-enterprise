import { createServerSupabaseClient } from "@/lib/auth/server";

// Server-only loader for the admin Users page. The account roster (auth
// emails, sign-in and ban state) comes through the admin-gated definer RPC
// admin_list_users — PostgREST cannot see the auth schema — and each user's
// org memberships join through the same admin_list_org_members RPC the
// Organizations page uses, so both panels agree on who belongs where.

export type AdministeredUserBan = {
  reason: string;
  bannedBy: string | null;
  bannedByEmail: string | null;
  bannedAt: string;
};

export type AdministeredUser = {
  id: string;
  email: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  orgs: Array<{ id: string; name: string }>;
  /** A row in platform_admins: the operator population, "experiential admin" in the UI. */
  isExperientialAdmin: boolean;
  /** The active ban record; null means the account is in good standing. */
  ban: AdministeredUserBan | null;
};

type UserRow = {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  banned_until: string | null;
  ban_reason: string | null;
  banned_by: string | null;
  banned_by_email: string | null;
  banned_at: string | null;
};

type MemberRow = {
  org_id: string;
  user_id: string;
};

export async function listAdministeredUsers(): Promise<AdministeredUser[]> {
  const supabase = await createServerSupabaseClient();
  const [usersResult, membersResult, orgsResult, siteAdminsResult] = await Promise.all([
    supabase.rpc("admin_list_users"),
    supabase.rpc("admin_list_org_members"),
    supabase.from("organizations").select("id, name"),
    // Platform admins hold a select-all policy on platform_admins, so the
    // roster resolves under the viewer's own RLS session.
    supabase.from("platform_admins").select("user_id")
  ]);
  if (usersResult.error) {
    throw new Error(`Unable to list users: ${usersResult.error.message}`);
  }
  if (membersResult.error) {
    throw new Error(`Unable to list organization members: ${membersResult.error.message}`);
  }
  if (orgsResult.error) {
    throw new Error(`Unable to list organizations: ${orgsResult.error.message}`);
  }
  if (siteAdminsResult.error) {
    throw new Error(`Unable to list experiential admins: ${siteAdminsResult.error.message}`);
  }
  const siteAdminIds = new Set(
    ((siteAdminsResult.data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id)
  );
  const orgNames = new Map(
    ((orgsResult.data ?? []) as Array<{ id: string; name: string }>).map((org) => [org.id, org.name])
  );
  const orgsByUser = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of (membersResult.data ?? []) as MemberRow[]) {
    const orgs = orgsByUser.get(row.user_id) ?? [];
    orgs.push({ id: row.org_id, name: orgNames.get(row.org_id) ?? row.org_id });
    orgsByUser.set(row.user_id, orgs);
  }
  return ((usersResult.data ?? []) as UserRow[]).map((row) => ({
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    lastSignInAt: row.last_sign_in_at,
    orgs: orgsByUser.get(row.id) ?? [],
    isExperientialAdmin: siteAdminIds.has(row.id),
    ban:
      row.ban_reason !== null && row.banned_at !== null
        ? {
            reason: row.ban_reason,
            bannedBy: row.banned_by,
            bannedByEmail: row.banned_by_email,
            bannedAt: row.banned_at
          }
        : null
  }));
}
