import type { SupabaseClient } from "@supabase/supabase-js";

import {
  MODEL_PROVIDERS,
  isProviderConnectionStatus,
  type ModelProvider,
  type ProviderConnectionStatus
} from "@/lib/model-providers";

/**
 * The latest provider_account_snapshots row for one connection, condensed to
 * the figures a listing renders. Snapshots are written by the spend-refresh
 * path (keys-P2); `source` says whether the numbers came from the provider's
 * own API, our side (e.g. Cost Explorer), or the customer's self-report.
 */
export type ProviderAccountSnapshotSummary = {
  taken_at: string;
  spend_usd: number | null;
  credits_remaining_usd: number | null;
  usage_limit_usd: number | null;
  source: "provider_api" | "our_side" | "self_reported";
};

/**
 * One provider account in the org's listing — every field member-readable.
 * The credential itself lives in Vault behind service-role RPCs and neither
 * it nor its vault id is ever selected here; the row carries only the last
 * four characters and the non-secret config (Azure addressing, Bedrock
 * region/access-key id, Fireworks account id).
 */
export type ProviderConnectionSummary = {
  provider: ModelProvider;
  /** Every provider appears exactly once; unconnected ones say what is missing. */
  connected: boolean;
  config: Record<string, unknown> | null;
  credential_last4: string | null;
  /** Last4 of the optional admin key (Anthropic/OpenAI spend reporting); null = none stored. */
  spend_credential_last4: string | null;
  updated_at: string | null;
  /** Provider-verified key state: checked at hookup, updated by traffic. */
  status: ProviderConnectionStatus;
  status_detail: Record<string, unknown> | null;
  status_checked_at: string | null;
  status_source: "hookup_check" | "traffic" | null;
  /** Customer-declared remaining credit; null = not tracked. */
  declared_balance_usd: number | null;
  declared_balance_set_at: string | null;
  metered_spend_usd: number;
  low_balance_threshold_usd: number;
  latest_snapshot: ProviderAccountSnapshotSummary | null;
};

/**
 * One point in a provider's spend/credits history, oldest→newest, for the
 * overview credit-accounts sparkline. Only the plottable money values ride
 * here; `source` lets the caller keep real readings and drop self-reports.
 */
export type ProviderSnapshotPoint = {
  taken_at: string;
  spend_usd: number | null;
  credits_remaining_usd: number | null;
  source: "provider_api" | "our_side" | "self_reported";
};

/**
 * A connection plus its recent snapshot series, returned by the list route's
 * `?history=N` variant so the overview credit-accounts tiles can draw a
 * sparkline without a second round-trip per provider.
 */
export type ProviderConnectionWithHistory = ProviderConnectionSummary & {
  history: ProviderSnapshotPoint[];
};

type ProviderConnectionRow = {
  provider: string;
  config: Record<string, unknown> | null;
  credential_last4: string | null;
  spend_credential_last4: string | null;
  updated_at: string;
  status: string;
  status_detail: Record<string, unknown> | null;
  status_checked_at: string | null;
  status_source: "hookup_check" | "traffic" | null;
  declared_balance_usd: number | null;
  declared_balance_set_at: string | null;
  metered_spend_usd: number;
  low_balance_threshold_usd: number;
};

/**
 * Every model provider the org can connect, with the live state of each
 * connection — the single read behind both the settings integrations page and
 * GET /api/orgs/{orgId}/provider-connections. The caller has already
 * authorized the org; rows are member-readable under RLS and the explicit org
 * filter keeps a multi-org member's other connections out of this listing.
 */
export async function listProviderConnections(
  supabase: SupabaseClient,
  orgId: string
): Promise<ProviderConnectionSummary[]> {
  const { data, error } = await supabase
    .from("provider_connections")
    .select(
      "provider, config, credential_last4, spend_credential_last4, updated_at, status, status_detail, status_checked_at, status_source, declared_balance_usd, declared_balance_set_at, metered_spend_usd, low_balance_threshold_usd"
    )
    .eq("org_id", orgId);
  if (error) {
    throw new Error(`Unable to load provider connections: ${error.message}`);
  }
  const byProvider = new Map(
    ((data ?? []) as ProviderConnectionRow[]).map((row) => [row.provider, row])
  );
  return Promise.all(
    MODEL_PROVIDERS.map(async (provider): Promise<ProviderConnectionSummary> => {
      const row = byProvider.get(provider);
      if (row === undefined) {
        return {
          provider,
          connected: false,
          config: null,
          credential_last4: null,
          spend_credential_last4: null,
          updated_at: null,
          status: "unchecked",
          status_detail: null,
          status_checked_at: null,
          status_source: null,
          declared_balance_usd: null,
          declared_balance_set_at: null,
          metered_spend_usd: 0,
          low_balance_threshold_usd: 5,
          latest_snapshot: null
        };
      }
      return {
        provider,
        connected: true,
        config: row.config,
        credential_last4: row.credential_last4,
        spend_credential_last4: row.spend_credential_last4,
        updated_at: row.updated_at,
        status: isProviderConnectionStatus(row.status) ? row.status : "unchecked",
        status_detail: row.status_detail,
        status_checked_at: row.status_checked_at,
        status_source: row.status_source,
        declared_balance_usd: row.declared_balance_usd,
        declared_balance_set_at: row.declared_balance_set_at,
        metered_spend_usd: row.metered_spend_usd,
        low_balance_threshold_usd: row.low_balance_threshold_usd,
        latest_snapshot: await latestSnapshot(supabase, orgId, provider)
      };
    })
  );
}

/**
 * The same listing plus a recent snapshot series per connected provider, for
 * the overview credit-accounts sparklines. Unconnected providers carry an
 * empty history; `historyLimit` caps the points read per provider.
 */
export async function listProviderConnectionsWithHistory(
  supabase: SupabaseClient,
  orgId: string,
  historyLimit: number
): Promise<ProviderConnectionWithHistory[]> {
  const connections = await listProviderConnections(supabase, orgId);
  return Promise.all(
    connections.map(async (connection): Promise<ProviderConnectionWithHistory> => ({
      ...connection,
      history: connection.connected
        ? await snapshotHistory(supabase, orgId, connection.provider, historyLimit)
        : []
    }))
  );
}

/**
 * The newest snapshot for one connection, or null when none exists yet.
 */
async function latestSnapshot(
  supabase: SupabaseClient,
  orgId: string,
  provider: ModelProvider
): Promise<ProviderAccountSnapshotSummary | null> {
  const { data, error } = await supabase
    .from("provider_account_snapshots")
    .select("taken_at, spend_usd, credits_remaining_usd, usage_limit_usd, source")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Unable to load provider account snapshots: ${error.message}`);
  }
  return (data as ProviderAccountSnapshotSummary | null) ?? null;
}

/**
 * Up to `limit` snapshot points for one connection, oldest→newest so the
 * sparkline reads left to right. Fetched newest-first with the limit, then
 * reversed, so the cap keeps the most recent window.
 */
async function snapshotHistory(
  supabase: SupabaseClient,
  orgId: string,
  provider: ModelProvider,
  limit: number
): Promise<ProviderSnapshotPoint[]> {
  const { data, error } = await supabase
    .from("provider_account_snapshots")
    .select("taken_at, spend_usd, credits_remaining_usd, source")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .order("taken_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Unable to load provider account snapshots: ${error.message}`);
  }
  return ((data ?? []) as ProviderSnapshotPoint[]).reverse();
}
