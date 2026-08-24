import { DEFAULT_SERVING_WINDOW } from "./serving-telemetry";
import type {
  KeyUsage,
  ServingWindow,
  UsageBucket,
  UsageLane,
  UsageRequestsCursor,
  UsageRequestItem
} from "./types";

// Pure helpers behind the Telemetry page: query-string construction for the
// gateway usage proxy routes, URL-persisted view state (filters are the URL,
// so a filtered view is shareable), bucket aggregation for the charts and
// tables, and display naming for the ledger's null cases. Kept free of React
// so the unit suite can pin the semantics.

// One page of the request table; the server page and the client view must
// agree or the first "Load more" duplicates or skips rows.
export const USAGE_PAGE_SIZE = 50;

const WINDOW_KEYS: ServingWindow[] = ["24h", "7d", "30d"];
const LANE_KEYS: UsageLane[] = ["platform", "byok"];

// The backend 400s non-uuid api_key_id filters; drop garbage at the parse so
// a mangled pasted URL degrades to "all agents" instead of an error page.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// URL-persisted view state. Every filter drives every section. Params:
// `window`, `model`, `agent` (api key id), `lane`, `status=error`, `live=1`.
// Only non-default values are written.
export type TelemetryViewState = {
  window: ServingWindow;
  /** Model alias filter; null = all models. */
  model: string | null;
  /** Agent (org API key id) filter; null = all agents. */
  agentId: string | null;
  /** Money lane filter; null = both lanes. */
  lane: UsageLane | null;
  /** Errors-only request log (`status=error`, the backend's shorthand). */
  errorsOnly: boolean;
  /** Auto-refresh: part of the view like every other control, so a reloaded
   * or pasted URL does not silently go static (the product owner, 2026-07-30). */
  live: boolean;
};

export const DEFAULT_TELEMETRY_VIEW: TelemetryViewState = {
  window: DEFAULT_SERVING_WINDOW,
  model: null,
  agentId: null,
  lane: null,
  errorsOnly: false,
  live: false
};

export function parseTelemetryView(
  searchParams: Record<string, string | string[] | undefined>
): TelemetryViewState {
  const single = (key: string): string | null => {
    const value = searchParams[key];
    return typeof value === "string" && value ? value : null;
  };
  const rawWindow = single("window");
  const rawLane = single("lane");
  const rawAgent = single("agent");
  return {
    window: WINDOW_KEYS.includes(rawWindow as ServingWindow)
      ? (rawWindow as ServingWindow)
      : DEFAULT_SERVING_WINDOW,
    model: single("model"),
    agentId: rawAgent !== null && UUID_PATTERN.test(rawAgent) ? rawAgent : null,
    lane: LANE_KEYS.includes(rawLane as UsageLane) ? (rawLane as UsageLane) : null,
    errorsOnly: single("status") === "error",
    live: single("live") === "1"
  };
}

export function telemetryViewQueryString(state: TelemetryViewState): string {
  const params = new URLSearchParams();
  if (state.window !== DEFAULT_SERVING_WINDOW) {
    params.set("window", state.window);
  }
  if (state.model !== null) {
    params.set("model", state.model);
  }
  if (state.agentId !== null) {
    params.set("agent", state.agentId);
  }
  if (state.lane !== null) {
    params.set("lane", state.lane);
  }
  if (state.errorsOnly) {
    params.set("status", "error");
  }
  if (state.live) {
    params.set("live", "1");
  }
  return params.toString();
}

// --- Backend query construction ------------------------------------------------

export type UsageTimeseriesQuery = {
  window?: ServingWindow;
  model?: string;
  apiKeyId?: string;
  lane?: UsageLane;
};

/** Build the query string the usage timeseries proxy route (and backend) accept. */
export function usageTimeseriesQueryString(query: UsageTimeseriesQuery): string {
  const params = new URLSearchParams();
  if (query.window) {
    params.set("window", query.window);
  }
  if (query.model) {
    params.set("model", query.model);
  }
  if (query.apiKeyId) {
    params.set("api_key_id", query.apiKeyId);
  }
  if (query.lane) {
    params.set("lane", query.lane);
  }
  return params.toString();
}

/** Parse a proxy route's incoming search params back into a timeseries query. */
export function usageTimeseriesQueryFromSearchParams(
  params: URLSearchParams
): UsageTimeseriesQuery {
  const query: UsageTimeseriesQuery = {};
  const window = params.get("window");
  if (WINDOW_KEYS.includes(window as ServingWindow)) {
    query.window = window as ServingWindow;
  }
  const model = params.get("model");
  if (model) {
    query.model = model;
  }
  const apiKeyId = params.get("api_key_id");
  if (apiKeyId) {
    query.apiKeyId = apiKeyId;
  }
  const lane = params.get("lane");
  if (LANE_KEYS.includes(lane as UsageLane)) {
    query.lane = lane as UsageLane;
  }
  return query;
}

export type UsageRequestsQuery = UsageTimeseriesQuery & {
  /** "error" is the backend's aggregate shorthand for every non-completed state. */
  status?: "error";
  cursor?: UsageRequestsCursor;
  limit?: number;
};

/** Build the query string the request-log proxy route (and backend) accept. */
export function usageRequestsQueryString(query: UsageRequestsQuery): string {
  const params = new URLSearchParams(usageTimeseriesQueryString(query));
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.cursor) {
    params.set("cursor_ts", query.cursor.ts);
    params.set("cursor_id", query.cursor.id);
    params.set("cursor_after", query.cursor.after);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  return params.toString();
}

/** Parse a proxy route's incoming search params back into a request-log query. */
export function usageRequestsQueryFromSearchParams(params: URLSearchParams): UsageRequestsQuery {
  const query: UsageRequestsQuery = usageTimeseriesQueryFromSearchParams(params);
  const status = params.get("status");
  if (status === "error") {
    query.status = status;
  }
  const cursorTs = params.get("cursor_ts");
  const cursorId = params.get("cursor_id");
  const cursorAfter = params.get("cursor_after");
  if (cursorTs && cursorId && cursorAfter) {
    query.cursor = { ts: cursorTs, id: cursorId, after: cursorAfter };
  }
  const limit = params.get("limit");
  if (limit && /^\d+$/.test(limit)) {
    query.limit = Number(limit);
  }
  return query;
}

/** The backend reads the current view state as one filtered request-log query. */
export function usageRequestsQueryFromView(
  view: TelemetryViewState,
  cursor?: UsageRequestsCursor
): UsageRequestsQuery {
  return {
    window: view.window,
    model: view.model ?? undefined,
    apiKeyId: view.agentId ?? undefined,
    lane: view.lane ?? undefined,
    status: view.errorsOnly ? "error" : undefined,
    cursor,
    limit: USAGE_PAGE_SIZE
  };
}

// --- Aggregation ---------------------------------------------------------------

export type UsageTotals = {
  requestCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Charged platform credits only. */
  costUsd: number;
  /** Attributed, never-charged pass-through estimate. */
  estimatedCostUsd: number;
};

const ZERO_TOTALS: UsageTotals = {
  requestCount: 0,
  errorCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  estimatedCostUsd: 0
};

function addBucket(totals: UsageTotals, bucket: UsageBucket): UsageTotals {
  return {
    requestCount: totals.requestCount + bucket.request_count,
    errorCount: totals.errorCount + bucket.error_count,
    inputTokens: totals.inputTokens + bucket.input_tokens,
    outputTokens: totals.outputTokens + bucket.output_tokens,
    costUsd: totals.costUsd + bucket.cost_usd,
    estimatedCostUsd: totals.estimatedCostUsd + bucket.estimated_cost_usd
  };
}

/** Window totals across every (bucket, model, lane) cell. */
export function usageTotals(buckets: UsageBucket[]): UsageTotals {
  return buckets.reduce(addBucket, ZERO_TOTALS);
}

/** "All spend" for ordering and headlines: charged plus attributed estimate. */
export function allSpendUsd(totals: { costUsd: number; estimatedCostUsd: number }): number {
  return totals.costUsd + totals.estimatedCostUsd;
}

export type ModelRollup = UsageTotals & { model: string };

/** Per-model window totals, biggest all-spend first (requests break ties). */
export function modelRollups(buckets: UsageBucket[]): ModelRollup[] {
  const byModel = new Map<string, UsageTotals>();
  for (const bucket of buckets) {
    byModel.set(bucket.model, addBucket(byModel.get(bucket.model) ?? ZERO_TOTALS, bucket));
  }
  return [...byModel.entries()]
    .map(([model, totals]) => ({ model, ...totals }))
    .sort((a, b) => allSpendUsd(b) - allSpendUsd(a) || b.requestCount - a.requestCount);
}

// One spend line on the chart: a label plus one dollar value per filled
// bucket, aligned with the shared `starts` axis.
export type SpendSeries = {
  key: string;
  label: string;
  points: number[];
};

export type SpendChartData = {
  /** Bucket start times (ms), contiguous across the whole window. */
  starts: number[];
  series: SpendSeries[];
};

/** Contiguous bucket starts covering the window, so quiet periods stay visible. */
export function fillBucketStarts(
  bucketSeconds: number,
  windowKey: ServingWindow,
  nowMs: number
): number[] {
  const windowSeconds = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 }[windowKey];
  const stepMs = bucketSeconds * 1000;
  const endMs = Math.floor(nowMs / stepMs) * stepMs;
  const startMs = Math.floor((nowMs - windowSeconds * 1000) / stepMs) * stepMs;
  const starts: number[] = [];
  for (let at = startMs; at <= endMs; at += stepMs) {
    starts.push(at);
  }
  return starts;
}

/**
 * Spend over time, one series per money lane. The lane split IS the money
 * split: the platform series is charged credits, the BYOK series is the
 * never-charged pass-through estimate, so layering them keeps an estimate
 * from ever reading as billed money. Undispatched cells carry no dollars and
 * add nothing here.
 */
export function laneSpendSeries(
  buckets: UsageBucket[],
  bucketSeconds: number,
  windowKey: ServingWindow,
  nowMs: number
): SpendChartData {
  const starts = fillBucketStarts(bucketSeconds, windowKey, nowMs);
  const index = new Map(starts.map((at, position) => [at, position]));
  const platform = new Array<number>(starts.length).fill(0);
  const byok = new Array<number>(starts.length).fill(0);
  for (const bucket of buckets) {
    const position = index.get(Date.parse(bucket.bucket_start));
    if (position === undefined) {
      continue;
    }
    if (bucket.lane === "platform") {
      platform[position] += bucket.cost_usd + bucket.estimated_cost_usd;
    } else if (bucket.lane === "byok") {
      byok[position] += bucket.cost_usd + bucket.estimated_cost_usd;
    }
  }
  return {
    starts,
    series: [
      { key: "platform", label: "Platform credits", points: platform },
      { key: "byok", label: "BYOK (est. pass-through)", points: byok }
    ]
  };
}

/**
 * All spend over time as ONE combined series: platform-funded and BYOK dollars
 * summed per bucket (the /credits graph — the product owner, credits redesign 2026-08-22:
 * the money page always shows spend combined, never split into funding
 * sub-views). Undispatched cells carry no dollars and add nothing here.
 */
export function totalSpendSeries(
  buckets: UsageBucket[],
  bucketSeconds: number,
  windowKey: ServingWindow,
  nowMs: number
): SpendChartData {
  const starts = fillBucketStarts(bucketSeconds, windowKey, nowMs);
  const index = new Map(starts.map((at, position) => [at, position]));
  const points = new Array<number>(starts.length).fill(0);
  for (const bucket of buckets) {
    const position = index.get(Date.parse(bucket.bucket_start));
    if (position === undefined) {
      continue;
    }
    points[position] += bucket.cost_usd + bucket.estimated_cost_usd;
  }
  return { starts, series: [{ key: "all", label: "All spend", points }] };
}

// A line per model stays readable up to about this many; the rest of the
// pool aggregates into "Other" so the total never understates.
const MAX_MODEL_SERIES = 5;

/** Spend over time per model, biggest spenders first, the tail as "Other". */
export function modelSpendSeries(
  buckets: UsageBucket[],
  bucketSeconds: number,
  windowKey: ServingWindow,
  nowMs: number
): SpendChartData {
  const starts = fillBucketStarts(bucketSeconds, windowKey, nowMs);
  const index = new Map(starts.map((at, position) => [at, position]));
  const ordered = modelRollups(buckets);
  const named = ordered.slice(0, MAX_MODEL_SERIES);
  const namedKeys = new Set(named.map((rollup) => rollup.model));
  const series: SpendSeries[] = named.map((rollup) => ({
    key: rollup.model,
    label: displayModel(rollup.model),
    points: new Array<number>(starts.length).fill(0)
  }));
  const other: SpendSeries = {
    key: " other",
    label: "Other",
    points: new Array<number>(starts.length).fill(0)
  };
  const byKey = new Map(series.map((entry) => [entry.key, entry]));
  for (const bucket of buckets) {
    const position = index.get(Date.parse(bucket.bucket_start));
    if (position === undefined) {
      continue;
    }
    const target = namedKeys.has(bucket.model) ? byKey.get(bucket.model)! : other;
    target.points[position] += bucket.cost_usd + bucket.estimated_cost_usd;
  }
  if (ordered.length > MAX_MODEL_SERIES) {
    series.push(other);
  }
  return { starts, series };
}

/**
 * Nearest-rank latency percentiles over the loaded request rows. The gateway
 * aggregates carry no latency, so the page derives p50/p95 from the request
 * log it already fetched and labels the sample size honestly.
 */
export function latencyPercentiles(
  requests: UsageRequestItem[]
): { p50: number; p95: number; sample: number } | null {
  const latencies = requests
    .map((request) => request.latency_ms)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (latencies.length === 0) {
    return null;
  }
  const rank = (fraction: number): number =>
    latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil(fraction * latencies.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), sample: latencies.length };
}

// --- Display naming for the ledger's null cases ----------------------------------

/** Rows the emitter settled before model attribution existed. */
export function displayModel(model: string): string {
  return model === "" ? "(unattributed)" : model;
}

/** Null lane means the request never dispatched to a provider. */
export function laneLabel(lane: UsageLane | null): string {
  switch (lane) {
    case "platform":
      return "Platform";
    case "byok":
      return "BYOK";
    case null:
      return "(undispatched)";
  }
}

/**
 * The agent column's name for a key rollup or request row: a live key's
 * label; a key deleted after settlement keeps its id (label gone); a key
 * hard-deleted before settlement has neither and groups as "(deleted key)".
 */
export function agentLabel(apiKeyId: string | null, keyLabel: string | null): string {
  if (apiKeyId === null) {
    return "(deleted key)";
  }
  if (keyLabel === null) {
    return `${apiKeyId.slice(0, 8)} (deleted)`;
  }
  return keyLabel;
}

/** One tool and how many of the loaded requests invoked it. */
export type ToolUsageRollup = {
  name: string;
  count: number;
};

/**
 * Top tools across the loaded request rows, most-used first (ties broken by
 * name so the order is stable). Each request contributes its distinct tool
 * names once, so `count` is "requests that used this tool" in the current
 * view. Returns an empty list when no loaded request captured any tool — the
 * page renders its honest empty state from that.
 */
export function topToolsUsed(requests: UsageRequestItem[], limit: number): ToolUsageRollup[] {
  const counts = new Map<string, number>();
  for (const request of requests) {
    for (const tool of request.tools_used) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Model filter options: every model the window saw, biggest spender first. */
export function modelOptions(buckets: UsageBucket[], keys: KeyUsage[]): string[] {
  const fromBuckets = modelRollups(buckets).map((rollup) => rollup.model);
  const seen = new Set(fromBuckets);
  const options = [...fromBuckets];
  for (const key of keys) {
    for (const usage of key.models) {
      if (!seen.has(usage.model)) {
        seen.add(usage.model);
        options.push(usage.model);
      }
    }
  }
  return options;
}
