import { createServerSupabaseClient } from "@/lib/auth/server";
import { getDataSource } from "@/lib/data-source";
import type { ToolAccountState } from "@/lib/tool-accounts";

// Server-only reads for the /credits tool-accounts panel. Kept beside the
// provider-connection loader so the credits page fetches both the same way.
// The list itself comes from the backend (Vault-backed credentials, the
// declared-balance gauge, and the last fetch verdict); the YC-company check
// reads the `yc` org label directly with the member-scoped server client so a
// non-YC org never even sees the gated vendors.

/** Load one state per tracked tool vendor for the org, connected or not. */
export async function loadToolAccounts(orgId: string): Promise<ToolAccountState[]> {
  return getDataSource().listToolAccounts(orgId);
}

/**
 * Whether the org is a YC company: true iff it carries the `yc` org label.
 * RLS (org_labels_select_yc_member) lets an org member SELECT their own org's
 * `yc` label, so this member-scoped read returns the row only for an org the
 * caller belongs to. Throws on a real read error, like the provider-connection
 * loader.
 */
export async function orgIsYcCompany(orgId: string): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("org_labels")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("key", "yc")
    .limit(1);
  if (error) {
    throw new Error(`Unable to load YC label: ${error.message}`);
  }
  return (data ?? []).length > 0;
}
