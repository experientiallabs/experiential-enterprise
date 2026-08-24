// Pure aggregation behind the Activity dashboard's deep graphs. Everything is
// derived from the gateway usage aggregates the Telemetry/Logs page already
// reads (UsageTimeseries buckets, UsageByKey, UsageByProvider), so nothing on
// the dashboard is invented. Kept free of React so the unit suite can pin the
// math.
//
// Model series order and color are anchored to all-spend rank (modelRollups)
// across every chart, so one model keeps the same slot and hue whether the
// chart plots spend, tokens, or request volume.

import {
  allSpendUsd,
  fillBucketStarts,
  displayModel,
  modelRollups,
  type SpendChartData,
  type SpendSeries
} from "./gateway-telemetry";
import { OTHER_SERIES_KEY } from "./gateway-usage";
import type { KeyUsage, ProviderUsage, ServingWindow, UsageBucket } from "./types";

/** A per-model metric a stacked bar chart can plot over the window. */
export type UsageSeriesMetric = "spend" | "tokens" | "requests";

// A line/band per model stays readable up to about this many; the tail folds
// into "Other" so the stack total never understates the window.
const MAX_MODEL_SERIES = 6;

function bucketMetricValue(bucket: UsageBucket, metric: UsageSeriesMetric): number {
  switch (metric) {
    case "spend":
      return bucket.cost_usd + bucket.estimated_cost_usd;
    case "tokens":
      return bucket.input_tokens + bucket.output_tokens;
    case "requests":
      return bucket.request_count;
  }
}

/**
 * Per-model value over time for one metric, biggest all-spenders first and the
 * tail as "Other", laid out on the window's contiguous bucket axis so quiet
 * periods stay visible. The shape matches SpendChartData so the shared chart
 * primitives can render it directly.
 */
export function modelUsageSeries(
  buckets: UsageBucket[],
  bucketSeconds: number,
  windowKey: ServingWindow,
  nowMs: number,
  metric: UsageSeriesMetric
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
    key: OTHER_SERIES_KEY,
    label: "Other",
    points: new Array<number>(starts.length).fill(0)
  };
  const byKey = new Map(series.map((entry) => [entry.key, entry]));
  for (const bucket of buckets) {
    const position = index.get(Date.parse(bucket.bucket_start));
    if (position === undefined) {
      continue;
    }
    const target = namedKeys.has(bucket.model) ? (byKey.get(bucket.model) as SpendSeries) : other;
    target.points[position] += bucketMetricValue(bucket, metric);
  }
  if (ordered.length > MAX_MODEL_SERIES) {
    series.push(other);
  }
  return { starts, series };
}

/** One ranked row for the top-models / top-keys / providers lists. */
export type RankedRow = {
  key: string;
  label: string;
  /** Formatted headline value (already money/number formatted by the caller). */
  value: number;
  /** Optional secondary count shown beside the value. */
  detail: string | null;
  /** Share of the leader, for the row's bar width. */
  fraction: number;
};

/** Top models by all-spend this window (charged credits plus attributed est.). */
export function topModelsBySpend(buckets: UsageBucket[], limit: number): RankedRow[] {
  const rollups = modelRollups(buckets).filter((rollup) => allSpendUsd(rollup) > 0);
  if (rollups.length === 0) {
    return [];
  }
  const peak = allSpendUsd(rollups[0]);
  return rollups.slice(0, limit).map((rollup) => ({
    key: rollup.model,
    label: displayModel(rollup.model),
    value: allSpendUsd(rollup),
    detail: `${rollup.requestCount.toLocaleString("en-US")} req`,
    fraction: peak > 0 ? allSpendUsd(rollup) / peak : 0
  }));
}

/** Top API keys ("agents") by all-spend this window, requests as the tiebreak. */
export function topKeysBySpend(keys: KeyUsage[], limit: number): RankedRow[] {
  const rows = keys
    .map((key) => ({
      key: key.api_key_id ?? "deleted",
      label: key.key_label ?? (key.api_key_id ? `${key.api_key_id.slice(0, 8)} (deleted)` : "(deleted key)"),
      spend: key.totals.cost_usd + key.totals.estimated_cost_usd,
      requests: key.totals.request_count
    }))
    .filter((row) => row.spend > 0 || row.requests > 0)
    .sort((a, b) => b.spend - a.spend || b.requests - a.requests)
    .slice(0, limit);
  if (rows.length === 0) {
    return [];
  }
  const peak = rows[0].spend > 0 ? rows[0].spend : rows[0].requests;
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.spend,
    detail: `${row.requests.toLocaleString("en-US")} req`,
    fraction: peak > 0 ? (row.spend > 0 ? row.spend : row.requests) / peak : 0
  }));
}

/** Providers by all-spend this window; null provider is the undispatched bucket. */
export function providerRows(providers: ProviderUsage[], limit: number): RankedRow[] {
  const rows = providers
    .map((provider) => ({
      key: provider.provider ?? "undispatched",
      provider: provider.provider,
      spend: provider.cost_usd + provider.estimated_cost_usd,
      requests: provider.request_count
    }))
    .filter((row) => row.spend > 0 || row.requests > 0)
    .sort((a, b) => b.spend - a.spend || b.requests - a.requests)
    .slice(0, limit);
  if (rows.length === 0) {
    return [];
  }
  const peak = rows[0].spend > 0 ? rows[0].spend : rows[0].requests;
  return rows.map((row) => ({
    key: row.key,
    label: row.provider ?? "(undispatched)",
    value: row.spend,
    detail: `${row.requests.toLocaleString("en-US")} req`,
    fraction: peak > 0 ? (row.spend > 0 ? row.spend : row.requests) / peak : 0
  }));
}

/**
 * Blended dollars per million tokens: all-spend over total tokens, scaled to a
 * million. Null when the window moved no tokens (dividing would read as $0/M,
 * which is not the same as "nothing happened").
 */
export function blendedPerMillionUsd(
  allSpend: number,
  totalTokens: number
): number | null {
  if (totalTokens <= 0) {
    return null;
  }
  return (allSpend / totalTokens) * 1_000_000;
}

// DATA GAP (intentionally omitted from the dashboard, not faked): OpenRouter's
// Activity view also shows cache-hit-rate, a reasoning/prompt/completion token
// breakdown, and "top apps". The gateway exposes cached_input_tokens and
// reasoning_tokens ONLY per request (UsageRequestItem), never as a windowed
// aggregate, and carries no app/referrer attribution at all. Surfacing those
// would mean either a new backend aggregate or paging the whole request log,
// so they are left out here rather than shown from a partial or invented
// number. Add them when a windowed aggregate exists.
