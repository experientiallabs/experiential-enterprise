import { cache } from "react";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { DataSourceNotFoundError } from "@/lib/errors";

import { loadSupabaseAuthSettings } from "./config";
import { createServerSupabaseClient, getAuthenticatedUser } from "./server";

// Server-only service-role client for admin operations (invite management,
// unprovisioned-user cleanup). Bypasses RLS — never hand it to client code.
export function createServiceRoleSupabaseClient(): SupabaseClient {
  const { url } = loadSupabaseAuthSettings();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set for admin operations.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

// Best-effort removal of an auth user created by a first sign-in while
// signups were disabled. Deleting the orphan matters beyond tidiness: the
// provisioning trigger only fires on auth.users INSERT, so a lingering
// memberless user could never be provisioned by a later invite. Membership is
// re-checked under the service role so a provisioned user is never deleted,
// and failures are swallowed — the sign-in rejection does not depend on this.
export async function deleteUnprovisionedUser(userId: string): Promise<void> {
  try {
    const admin = createServiceRoleSupabaseClient();
    const { count, error } = await admin
      .from("organization_members")
      .select("org_id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error || (count ?? 0) > 0) {
      return;
    }
    await admin.auth.admin.deleteUser(userId);
  } catch {
    // Missing service key or a GoTrue hiccup leaves a harmless orphan row.
  }
}

// Request-scoped: the sidebar packet and the admin routes both ask whether the
// signed-in user is a platform operator; one RLS-scoped read serves the render.
// platform_admins lets a user select only their own row, so this resolves the
// flag without exposing the roster.
export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const user = await getAuthenticatedUser();
  if (user === null) {
    return false;
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    throw new Error(`Unable to verify platform admin status: ${error.message}`);
  }
  return data !== null;
});

// Admin surfaces render as not-found for everyone else, so their existence is
// not distinguishable from an absent route.
export async function requirePlatformAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) {
    throw new DataSourceNotFoundError("Not found");
  }
}
