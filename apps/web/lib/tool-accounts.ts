// The developer-tool vendor accounts shown on /credits beside the inference
// provider balances. Unlike model providers, tool accounts carry no gateway
// metering: there is no serving path drawing them down, so "remaining" is just
// the declared balance. Each account tracks a self-reported balance and can be
// asked to fetch its real balance from the vendor. E2B is visible to every org;
// Greptile, Cursor, and Devin are YC-only (gated by the `yc` org label).

export const TRACKED_TOOL_VENDORS = ["e2b", "greptile", "cursor", "devin"] as const;

export type TrackedToolVendor = (typeof TRACKED_TOOL_VENDORS)[number];

// The vendors only YC companies may see and manage. E2B is deliberately absent:
// it is visible to everyone and never gated.
export const YC_GATED_TOOL_VENDORS = ["greptile", "cursor", "devin"] as const;

export function isTrackedToolVendor(value: string): value is TrackedToolVendor {
  return (TRACKED_TOOL_VENDORS as readonly string[]).includes(value);
}

export function isYcGatedToolVendor(vendor: string): boolean {
  return (YC_GATED_TOOL_VENDORS as readonly string[]).includes(vendor);
}

const TOOL_VENDOR_LABELS: Record<TrackedToolVendor, string> = {
  e2b: "E2B",
  greptile: "Greptile",
  cursor: "Cursor",
  devin: "Devin"
};

export function toolVendorLabel(vendor: TrackedToolVendor): string {
  return TOOL_VENDOR_LABELS[vendor];
}

/**
 * One tool account's state for the org, connected or not. Mirrors the backend
 * ToolAccountView. The credential is stored server-side (Vault); the client
 * only ever sees its last four digits and the declared-balance gauge.
 */
export type ToolAccountState = {
  vendor: TrackedToolVendor;
  connected: boolean;
  ycGated: boolean;
  config: Record<string, unknown> | null;
  credentialLast4: string | null;
  declaredBalanceUsd: number | null;
  declaredBalanceSetAt: string | null;
  balanceSource: "self_reported" | "vendor_api" | "computer_use" | null;
  lowBalanceThresholdUsd: number;
  lastFetchAt: string | null;
  lastFetchStatus: "reported" | "not_reportable" | "read_failed" | "pending" | null;
  lastFetchMessage: string | null;
};

/**
 * The verdict of a fetch-balance request: a reported figure, the vendor's
 * honest "cannot report" state, a failed read, or an accepted async job still
 * running (kind "pending": the computer-use strategy fetches out of band).
 */
export type ToolBalanceFetchResult = {
  vendor: TrackedToolVendor;
  kind: "reported" | "not_reportable" | "read_failed" | "pending";
  strategy: "deterministic" | "computer_use";
  refreshed: boolean;
  balanceUsd: number | null;
  source: "vendor_api" | "computer_use" | null;
  message: string;
};

/**
 * What is left on the tool account. Tool accounts have no gateway metering, so
 * remaining is exactly the declared balance; null when no balance is tracked
 * (never a fake $0, matching the provider-balance convention).
 */
export function toolAccountRemaining(state: ToolAccountState): number | null {
  return state.declaredBalanceUsd;
}

/** A tracked balance at or below the account's low-balance threshold. */
export function toolAccountBalanceLow(state: ToolAccountState): boolean {
  const remaining = toolAccountRemaining(state);
  return remaining !== null && remaining <= state.lowBalanceThresholdUsd;
}

/**
 * The summary of one scheduled balance-fetch run: how many provider accounts
 * and tool accounts the worker checked, how many readings it wrote, how many it
 * skipped for a staleness floor, and how many errored. Returned by the pg_cron
 * internal edge so the caller can log a run without opening the worker.
 */
export type BalanceFetchRunSummary = {
  providersChecked: number;
  providerSnapshotsWritten: number;
  providersSkippedFloor: number;
  toolAccountsChecked: number;
  toolBalancesUpdated: number;
  errors: number;
};
