import { createServerSupabaseClient } from "@/lib/auth/server";
import { MODEL_PROVIDERS, isProviderConnectionStatus } from "@/lib/model-providers";
import type { ProviderAccountSnapshot } from "@/lib/model-providers";
import type { ProviderConnectionState } from "@/components/settings/ModelProvidersPanel";

// Server-only loader for the org's own model-provider accounts. Split from the
// pure balance helpers so client surfaces (the credits balances view) can share
// the math without pulling the Supabase server client into their bundle. The
// row is member-readable under RLS and carries only non-secret state: the key
// lives in Vault behind service-role RPCs, so we only ever see the last four
// digits, Azure's non-secret addressing, the declared-balance drawdown, and the
// optional admin key's last four. This single loader carries all three domains'
// fields — connection status, the self-reported balance drawdown, and the
// latest real provider spend reading — so the settings panel, the /credits
// balances view, and the API listing cannot drift.
type ProviderRow = {
  provider: string;
  config: Record<string, unknown> | null;
  credential_last4: string | null;
  spend_credential_last4: string | null;
  updated_at: string;
  status: string;
  status_detail: Record<string, unknown> | null;
  status_checked_at: string | null;
  declared_balance_usd: number | null;
  declared_balance_set_at: string | null;
  metered_spend_usd: number;
  low_balance_threshold_usd: number;
};

type SnapshotRow = {
  provider: string;
  taken_at: string;
  source: ProviderAccountSnapshot["source"];
  spend_usd: number | string | null;
  credits_remaining_usd: number | string | null;
  usage_limit_usd: number | string | null;
  detail: Record<string, unknown> | null;
};

// Postgres numeric can arrive as a decimal string; the panel does math on it.
function dollars(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Load one state per known model provider for the org, connected or not, so the
 * settings panel and the /credits balances view both render every provider with
 * an honest connected/empty state. The explicit org filter keeps a multi-org
 * member's other connections off the page.
 */
export async function loadProviderConnections(
  orgId: string
): Promise<ProviderConnectionState[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("provider_connections")
    .select(
      "provider, config, credential_last4, spend_credential_last4, updated_at, status, status_detail, status_checked_at, declared_balance_usd, declared_balance_set_at, metered_spend_usd, low_balance_threshold_usd"
    )
    .eq("org_id", orgId);
  if (error) {
    throw new Error(`Unable to load provider connections: ${error.message}`);
  }
  const byProvider = new Map(((data ?? []) as ProviderRow[]).map((row) => [row.provider, row]));

  // The newest real reading PER connected provider — fetched per provider (a
  // bounded set) rather than as one org-wide top-N, so a single busy provider's
  // readings can't fill the window and hide a quieter provider's latest reading.
  // Self-reported rows are excluded: they are the customer's own declaration,
  // not a provider/our-side reading.
  const connectedProviders = [...byProvider.keys()];
  const latestByProvider = new Map<string, ProviderAccountSnapshot>();
  const snapshotResults = await Promise.all(
    connectedProviders.map((provider) =>
      supabase
        .from("provider_account_snapshots")
        .select("provider, taken_at, source, spend_usd, credits_remaining_usd, usage_limit_usd, detail")
        .eq("org_id", orgId)
        .eq("provider", provider)
        .neq("source", "self_reported")
        .order("taken_at", { ascending: false })
        .limit(1)
    )
  );
  for (const { data: rows, error: snapshotError } of snapshotResults) {
    if (snapshotError) {
      throw new Error(`Unable to load provider account snapshots: ${snapshotError.message}`);
    }
    const row = ((rows ?? []) as SnapshotRow[])[0];
    if (row !== undefined) {
      latestByProvider.set(row.provider, {
        taken_at: row.taken_at,
        source: row.source,
        spend_usd: dollars(row.spend_usd),
        credits_remaining_usd: dollars(row.credits_remaining_usd),
        usage_limit_usd: dollars(row.usage_limit_usd),
        detail: row.detail
      });
    }
  }

  return MODEL_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      connected: row !== undefined,
      credentialLast4: row?.credential_last4 ?? null,
      config: row?.config ?? null,
      updatedAt: row?.updated_at ?? null,
      status:
        row !== undefined && isProviderConnectionStatus(row.status) ? row.status : "unchecked",
      statusDetail: row?.status_detail ?? null,
      statusCheckedAt: row?.status_checked_at ?? null,
      spendCredentialLast4: row?.spend_credential_last4 ?? null,
      declaredBalanceUsd: row?.declared_balance_usd ?? null,
      declaredBalanceSetAt: row?.declared_balance_set_at ?? null,
      meteredSpendUsd: row?.metered_spend_usd ?? 0,
      lowBalanceThresholdUsd: row?.low_balance_threshold_usd ?? 5,
      latestSnapshot: latestByProvider.get(provider) ?? null
    };
  });
}
