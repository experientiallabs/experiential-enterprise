import type { SupabaseClient } from "@supabase/supabase-js";

import type { ApiKeyRow, ApiKeySummary } from "./types";

export const API_KEYS_PAGE_SIZE = 10;

export type ApiKeysPage = {
  keys: ApiKeyRow[];
  page: number;
  pageCount: number;
  total: number;
};

// The full member-readable column set — the hash never leaves the database,
// and the plaintext exists only inside the mint response.
const API_KEY_COLUMNS =
  "id, org_id, name, key_prefix, key_suffix, created_at, last_used_at, revoked_at, expires_at, identity_id";

/**
 * One page of an organization's API keys, newest first.
 *
 * The single read behind both the settings page and GET /api/keys, so the two
 * can never drift on columns, ordering, or paging. The caller picks the
 * client (RLS for members, service role for platform admins) and has already
 * authorized the org; the explicit org filter keeps a multi-org member's
 * other keys out of this org's listing. Counting first lets an out-of-range
 * page clamp to the last real page instead of erroring.
 */
export async function listOrgApiKeys(
  supabase: SupabaseClient,
  input: { orgId: string; page: number; showRevoked: boolean; identityId?: string | null }
): Promise<ApiKeysPage> {
  const identityId = input.identityId ?? null;
  const countQuery = supabase
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("org_id", input.orgId);
  const scopedCount = identityId === null ? countQuery : countQuery.eq("identity_id", identityId);
  const { count, error: countError } = await (input.showRevoked
    ? scopedCount
    : scopedCount.is("revoked_at", null));
  if (countError) {
    throw new Error(`Unable to count API keys: ${countError.message}`);
  }
  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / API_KEYS_PAGE_SIZE));
  const page = Math.min(Math.max(Number.isNaN(input.page) ? 1 : input.page, 1), pageCount);

  const rowsQuery = supabase.from("api_keys").select(API_KEY_COLUMNS).eq("org_id", input.orgId);
  const scopedRows = identityId === null ? rowsQuery : rowsQuery.eq("identity_id", identityId);
  const { data, error } = await (input.showRevoked ? scopedRows : scopedRows.is("revoked_at", null))
    .order("created_at", { ascending: false })
    .range((page - 1) * API_KEYS_PAGE_SIZE, page * API_KEYS_PAGE_SIZE - 1);
  if (error) {
    throw new Error(`Unable to list API keys: ${error.message}`);
  }

  return { keys: (data ?? []) as ApiKeyRow[], page, pageCount, total };
}

/**
 * Every active (non-revoked) key of one org as label summaries, newest first.
 *
 * The unpaged sibling of `listOrgApiKeys`, for pickers that must offer the
 * whole key set at once (the budget scope selector) and for resolving a key
 * budget row to its key's name. Same authorization contract: the caller picks
 * the client and has already authorized the org.
 */
export async function listOrgApiKeySummaries(
  supabase: SupabaseClient,
  orgId: string
): Promise<ApiKeySummary[]> {
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, key_suffix")
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Unable to list API keys: ${error.message}`);
  }
  return (data ?? []) as ApiKeySummary[];
}
