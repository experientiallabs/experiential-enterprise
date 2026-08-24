// The Overview page's data language: the gateway daily-usage rollup rows as
// GET /api/gateway/usage/daily returns them, and the pure period/metric math
// every Overview section shares. One module owns this math so the summary
// figure, the per-day chart, and the activity stats can never disagree about
// what a period contains — the toggle-consistency tests pin that invariant.
//
// All day arithmetic is UTC: the gateway rollup buckets requests into UTC
// dates, so period boundaries computed in any local zone would split a
// bucket. "Today" is the current UTC day.

import { formatTokens } from "./format";
import { formatCostUsd } from "./money";

/**
 * The metric columns every rollup row carries; the period/metric math below
 * is typed against this floor so the per-org rows and the admin panel's
 * platform-wide rows (grouped by org instead of member) share it.
 */
export type UsageMetricRow = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** The ONE user-facing spend meter (charged + attributed estimates). */
  spend_micro_usd: number;
};

/** One rollup bucket; only the grouped dimension is non-null. */
export type GatewayUsageRow = UsageMetricRow & {
  day: string | null;
  user_id: string | null;
  alias: string | null;
};

export type GatewayUsageScope = "self" | "org";
export type GatewayUsageGroupBy = "day" | "day_model" | "model" | "member";

/** The payload shape of GET /api/gateway/usage/daily. */
export type GatewayDailyUsage = {
  org_id: string;
  scope: GatewayUsageScope;
  group_by: GatewayUsageGroupBy;
  rows: GatewayUsageRow[];
};

/** One platform-wide rollup bucket; only the grouped dimension is non-null. */
export type PlatformUsageRow = UsageMetricRow & {
  day: string | null;
  org_id: string | null;
  alias: string | null;
};

export type PlatformUsageGroupBy = "day" | "model" | "org";

/** The payload shape of GET /api/admin/telemetry/usage. */
export type PlatformDailyUsage = {
  group_by: PlatformUsageGroupBy;
  rows: PlatformUsageRow[];
};

/**
 * Matches the backend's RPC-side row cap on the usage rollup reads; the
 * all-time per-day series (~5.5 years of daily buckets) is the widest read
 * the Overview and the admin Telemetry panel make. One constant so the
 * tenant and platform proxy routes cannot drift from each other.
 */
export const USAGE_ROLLUP_LIMIT_CAP = 2000;

export type UsageMetric = "spend" | "tokens" | "requests";

export const USAGE_METRICS: readonly { key: UsageMetric; label: string }[] = [
  { key: "spend", label: "Spend" },
  { key: "tokens", label: "Tokens" },
  { key: "requests", label: "Requests" }
];

export type UsagePeriod = "today" | "7d" | "30d" | "1y" | "all";

export const USAGE_PERIODS: readonly { key: UsagePeriod; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "1y", label: "1y" },
  { key: "all", label: "All time" }
];

/**
 * Inclusive UTC day range. `from: null` means unbounded history (all time);
 * `to` always names a concrete day so series have a right edge to fill to.
 */
export type DayRange = { from: string | null; to: string };

/** The current UTC day as YYYY-MM-DD. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

/** Days spanned by an equal-length period, for previous-period arithmetic. */
const PERIOD_DAYS: Record<Exclude<UsagePeriod, "all">, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "1y": 365
};

export function periodRange(period: UsagePeriod, today: string): DayRange {
  if (period === "all") {
    return { from: null, to: today };
  }
  return { from: addDays(today, -(PERIOD_DAYS[period] - 1)), to: today };
}

/**
 * The equal-length period immediately before, for the summary delta. All
 * time has no previous period — the delta simply does not render.
 */
export function previousPeriodRange(period: UsagePeriod, today: string): DayRange | null {
  if (period === "all") {
    return null;
  }
  const days = PERIOD_DAYS[period];
  const to = addDays(today, -days);
  return { from: addDays(to, -(days - 1)), to };
}

/**
 * A row's value in the chosen metric. Spend stays in integer micro-USD here
 * (sums stay exact); it becomes dollars only at format time.
 */
export function metricValue(row: UsageMetricRow, metric: UsageMetric): number {
  switch (metric) {
    case "spend":
      return row.spend_micro_usd;
    case "tokens":
      return row.input_tokens + row.output_tokens;
    case "requests":
      return row.requests;
  }
}

/** Compact display for any metric total; spend converts micro-USD → dollars. */
export function formatMetricValue(metric: UsageMetric, value: number): string {
  switch (metric) {
    case "spend":
      return formatCostUsd(value / 1_000_000);
    case "tokens":
      return formatTokens(value);
    case "requests":
      return value.toLocaleString("en-US");
  }
}

function dayInRange(day: string, range: DayRange): boolean {
  return (range.from === null || day >= range.from) && day <= range.to;
}

/** Rows whose (non-null) day falls inside the range. */
export function rowsInRange<T extends { day: string | null }>(rows: T[], range: DayRange): T[] {
  return rows.filter((row) => row.day !== null && dayInRange(row.day, range));
}

export function sumMetric(rows: UsageMetricRow[], metric: UsageMetric): number {
  return rows.reduce((sum, row) => sum + metricValue(row, metric), 0);
}

/**
 * Percent change vs the previous period, or null when there is nothing to
 * compare against (no previous period, or a zero baseline where any figure
 * would read as ∞).
 */
export function deltaPercent(current: number, previous: number): number | null {
  if (previous <= 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

export function formatDeltaPercent(delta: number): string {
  const rounded = Math.round(delta);
  return `${rounded >= 0 ? "+" : ""}${rounded.toLocaleString("en-US")}%`;
}

export type DailyPoint = { day: string; value: number };

/**
 * The zero-filled per-day series for one range and metric: one point per UTC
 * day, oldest first, no gaps. An unbounded range starts at the first recorded
 * day (or collapses to just `to` for an org with no history yet), so the
 * chart and the contribution graph always have a concrete left edge.
 */
export function dailySeries(
  rows: (UsageMetricRow & { day: string | null })[],
  range: DayRange,
  metric: UsageMetric
): DailyPoint[] {
  const byDay = new Map<string, number>();
  for (const row of rowsInRange(rows, range)) {
    // row.day is non-null after rowsInRange.
    const day = row.day as string;
    byDay.set(day, (byDay.get(day) ?? 0) + metricValue(row, metric));
  }
  const from =
    range.from ?? (byDay.size > 0 ? [...byDay.keys()].sort()[0] : range.to);
  const series: DailyPoint[] = [];
  for (let day = from; day <= range.to; day = addDays(day, 1)) {
    series.push({ day, value: byDay.get(day) ?? 0 });
  }
  return series;
}

// --- Per-day-per-model stacks (the Overview hero chart) ---------------------

/**
 * A legend/stack readability bound, not a data bound: the leading models get
 * named series and everything past them folds into "Other".
 */
const MAX_DAILY_MODEL_SERIES = 8;

/**
 * The Other fold's series key. The leading space cannot collide with a real
 * model alias (matching lib/activity-usage's fold key).
 */
export const OTHER_SERIES_KEY = " other";

const ZERO_METRICS: UsageMetricRow = {
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  spend_micro_usd: 0
};

/** One stacked series on the per-day chart: a top model, or the Other fold. */
export type DailyStackSeries = {
  key: string;
  label: string;
  /** Full metric cells aligned to the stack's day axis (the hover detail). */
  detail: UsageMetricRow[];
};

export type DailyModelStacks = {
  /** The zero-filled day axis; identical to dailySeries over the same range. */
  days: string[];
  /** Spend-ranked top models, then the Other fold when it carries anything. */
  series: DailyStackSeries[];
  /** Authoritative per-day totals (from the group_by=day read), aligned. */
  totals: UsageMetricRow[];
};

/**
 * Fold the per-(day, model) rollup into the hero chart's stacked series: the
 * top `maxSeries` models by range spend as named series (spend-anchored so a
 * model keeps its slot and color across the metric toggle, the
 * lib/activity-usage convention) and everything else as "Other".
 *
 * The day axis and per-day totals come from the group_by=day rows — the same
 * source as the headline figure — and "Other" is the per-day RESIDUAL against
 * those totals rather than a sum of tail rows. The stack therefore always adds
 * up to the summary total by construction, even when the per-model read was
 * row-capped and dropped its oldest cells (those days simply render as Other).
 *
 * `rankRows` (the group_by=model rollup over the same range) picks the named
 * series when given: it is aggregated server-side over the FULL range, so a
 * row-capped per-day read cannot demote a historically dominant model out of
 * the legend. Without it, ranking falls back to the per-day cells.
 */
export function dailyModelStacks(
  dayRows: (UsageMetricRow & { day: string | null })[],
  modelDayRows: (UsageMetricRow & { day: string | null; alias: string | null })[],
  range: DayRange,
  options: {
    rankRows?: (UsageMetricRow & { alias: string | null })[];
    maxSeries?: number;
  } = {}
): DailyModelStacks {
  const maxSeries = options.maxSeries ?? MAX_DAILY_MODEL_SERIES;
  // The axis and totals mirror dailySeries exactly (same range cut, same
  // zero-fill), carrying every metric so the hover can show spend, requests,
  // and tokens at once.
  const totalsByDay = new Map<string, UsageMetricRow>();
  for (const row of rowsInRange(dayRows, range)) {
    const day = row.day as string;
    const at = totalsByDay.get(day) ?? { ...ZERO_METRICS };
    totalsByDay.set(day, addMetrics(at, row));
  }
  const from =
    range.from ?? (totalsByDay.size > 0 ? [...totalsByDay.keys()].sort()[0] : range.to);
  const days: string[] = [];
  for (let day = from; day <= range.to; day = addDays(day, 1)) {
    days.push(day);
  }
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const totals = days.map((day) => totalsByDay.get(day) ?? { ...ZERO_METRICS });

  // Rank models by range spend (requests as the tiebreak so free-model orgs
  // still get a stable order), then bucket each cell into its named series.
  const cells = rowsInRange(modelDayRows, range);
  const perModel = new Map<string, UsageMetricRow>();
  for (const row of options.rankRows ?? cells) {
    const key = row.alias ?? "unknown";
    perModel.set(key, addMetrics(perModel.get(key) ?? { ...ZERO_METRICS }, row));
  }
  const ranked = [...perModel.entries()].sort(
    ([aliasA, a], [aliasB, b]) =>
      b.spend_micro_usd - a.spend_micro_usd ||
      b.requests - a.requests ||
      aliasA.localeCompare(aliasB)
  );
  const named = ranked.slice(0, maxSeries).map(([alias]) => alias);
  const series: DailyStackSeries[] = named.map((alias) => ({
    key: alias,
    label: alias,
    detail: days.map(() => ({ ...ZERO_METRICS }))
  }));
  const byKey = new Map(series.map((entry) => [entry.key, entry]));
  for (const row of cells) {
    const entry = byKey.get(row.alias ?? "unknown");
    const index = dayIndex.get(row.day as string);
    if (entry === undefined || index === undefined) {
      continue;
    }
    entry.detail[index] = addMetrics(entry.detail[index], row);
  }

  // Other = the per-day residual vs the authoritative totals, clamped at zero
  // so a snapshot skew between the two reads can never render negative.
  const other: DailyStackSeries = {
    key: OTHER_SERIES_KEY,
    label: "Other",
    detail: days.map((_, index) => {
      const namedSum = series.reduce(
        (sum, entry) => addMetrics(sum, entry.detail[index]),
        { ...ZERO_METRICS }
      );
      return {
        requests: Math.max(0, totals[index].requests - namedSum.requests),
        input_tokens: Math.max(0, totals[index].input_tokens - namedSum.input_tokens),
        output_tokens: Math.max(0, totals[index].output_tokens - namedSum.output_tokens),
        spend_micro_usd: Math.max(0, totals[index].spend_micro_usd - namedSum.spend_micro_usd)
      };
    })
  };
  if (other.detail.some((cell) => hasAnyMetric(cell))) {
    series.push(other);
  }
  return { days, series, totals };
}

function addMetrics(at: UsageMetricRow, row: UsageMetricRow): UsageMetricRow {
  return {
    requests: at.requests + row.requests,
    input_tokens: at.input_tokens + row.input_tokens,
    output_tokens: at.output_tokens + row.output_tokens,
    spend_micro_usd: at.spend_micro_usd + row.spend_micro_usd
  };
}

function hasAnyMetric(cell: UsageMetricRow): boolean {
  return (
    cell.requests > 0 ||
    cell.input_tokens > 0 ||
    cell.output_tokens > 0 ||
    cell.spend_micro_usd > 0
  );
}

/** Top rollup groups (model aliases or members) by the chosen metric. */
export function topGroups<T extends UsageMetricRow>(
  rows: T[],
  metric: UsageMetric,
  label: (row: T) => string,
  count: number
): { label: string; value: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = label(row);
    totals.set(key, (totals.get(key) ?? 0) + metricValue(row, metric));
  }
  return [...totals.entries()]
    .map(([groupLabel, value]) => ({ label: groupLabel, value }))
    .filter((group) => group.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, count);
}

export type ActivityStats = {
  /** Longest run of consecutive days with any activity in the window. */
  longestStreakDays: number;
  averagePerDay: number;
  averagePerWeek: number;
  total: number;
};

/** Activity figures for the contribution section, over one filled series. */
export function activityStats(series: DailyPoint[]): ActivityStats {
  let longest = 0;
  let run = 0;
  let total = 0;
  for (const point of series) {
    total += point.value;
    run = point.value > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const days = Math.max(series.length, 1);
  const averagePerDay = total / days;
  return {
    longestStreakDays: longest,
    averagePerDay,
    averagePerWeek: averagePerDay * 7,
    total
  };
}
