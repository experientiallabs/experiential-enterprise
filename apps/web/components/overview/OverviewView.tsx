"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";

import { ContributionGraph } from "@/components/overview/ContributionGraph";
import { DailyUsageChart } from "@/components/overview/DailyUsageChart";
import { UsageBreakdownTable } from "@/components/overview/UsageBreakdownTable";
import {
  useGatewayUsage,
  useMemberDirectory,
  type MemberDirectory
} from "@/components/overview/use-gateway-usage";
import { MODEL_SERIES_PALETTE, seriesColor } from "@/components/ui/chart-hover";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { Shimmer } from "@/components/ui/Shimmer";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import { formatKeyIdentity } from "@/lib/api-keys/format";
import type { ApiKeyRow } from "@/lib/api-keys/types";
import { ModelIcon } from "@/components/models-catalog/model-icon";
import {
  activityStats,
  addDays,
  dailyModelStacks,
  dailySeries,
  deltaPercent,
  formatDeltaPercent,
  formatMetricValue,
  periodRange,
  previousPeriodRange,
  rowsInRange,
  sumMetric,
  topGroups,
  USAGE_METRICS,
  USAGE_PERIODS,
  utcToday,
  type ActivityStats,
  type DailyPoint,
  OTHER_SERIES_KEY,
  type GatewayUsageRow,
  type UsageMetric,
  type UsageMetricRow,
  type UsagePeriod
} from "@/lib/gateway-usage";
import { aliasIconKey } from "@/lib/model-brand";
import { apiKeysPath, insightsPath, modelPath } from "@/lib/routes";
import type { ServingWindow } from "@/lib/types";

type OverviewScope = "personal" | "workspace";

// Workspace leads: the switcher only renders for admins, who land on (and
// read first) the org-wide view — Personal is the secondary cut (the product owner).
const SCOPE_TABS = [
  { key: "workspace", label: "Workspace" },
  { key: "personal", label: "Personal" }
] as const;

/**
 * The Insights window closest to an Overview period, so the "View full
 * activity" and "View all" links land on the same cut they left. Insights
 * offers only 24h/7d/30d; the wide periods (1y, all time) land on its widest.
 */
function insightsWindowFor(period: UsagePeriod): ServingWindow {
  switch (period) {
    case "today":
      return "24h";
    case "7d":
      return "7d";
    default:
      return "30d";
  }
}

const PERIOD_NOUN: Record<UsagePeriod, string> = {
  today: "yesterday",
  "7d": "the previous 7 days",
  "30d": "the previous 30 days",
  "1y": "the previous year",
  all: ""
};

// The activity contribution graph is a fixed 3-month window regardless of the
// period selector (the product owner, round-2: "90 days / 3 months"); the period toggle
// governs the usage summary, top models, and member breakdown only.
const ACTIVITY_DAYS = 90;

type OverviewViewProps = {
  org: { id: string; name: string };
  /**
   * Org admins (and platform admins) get the Personal | Workspace switcher
   * and land on Workspace ("land in org first" — the product owner); members see
   * Personal only and land there. Only these actors see the member breakdown.
   */
  canSeeWorkspace: boolean;
  /**
   * The catalog's routable slugs (lib/model-links), gating which top-model
   * rows link out to /models/{slug}; null (catalog unavailable) fails open
   * to linking everything.
   */
  knownModelSlugs: string[] | null;
};

/**
 * The signed-in landing: a compact OpenRouter-style overview whose hero is the
 * per-day usage chart. One page-level metric toggle (Spend | Tokens | Requests)
 * and one period selector re-render the usage summary, its per-day graph, and
 * the top models. The usage summary and its chart are the growth element (the
 * chart fills the card edge to edge and the row takes the free vertical space,
 * the product owner 2026-08), with the top-models rail beside it; the fixed-90-day activity
 * heatmap, the member breakdown, and the API-keys summary sit compactly below.
 * The deep analytics (stacked-by-model, credits vs BYOK, caching, per-key) live
 * on the Insights dashboard, which the summary's "View full activity" link and
 * the top-models "View all" link both point to.
 *
 * The all-time per-day series is fetched once per scope and every period cut
 * derives from it in lib/gateway-usage, so the summary, the chart, and the
 * activity stats always agree; only the grouped rollups (top models,
 * per-member) are separate reads bounded to the period.
 */
export function OverviewView({ org, canSeeWorkspace, knownModelSlugs }: OverviewViewProps) {
  const [scope, setScope] = useState<OverviewScope>(canSeeWorkspace ? "workspace" : "personal");
  const [metric, setMetric] = useState<UsageMetric>("spend");
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  // Pinned per mount: a page open across midnight UTC keeps one consistent
  // "today" rather than re-cutting every period mid-interaction.
  const [today] = useState(() => utcToday());

  const apiScope = scope === "workspace" ? ("org" as const) : ("self" as const);
  const range = periodRange(period, today);
  const previousRange = previousPeriodRange(period, today);
  const activityRange = useMemo(
    () => ({ from: addDays(today, -(ACTIVITY_DAYS - 1)), to: today }),
    [today]
  );

  const daySnap = useGatewayUsage({ orgId: org.id, scope: apiScope, groupBy: "day" });
  // The hero chart's per-model split, bounded to the period like the grouped
  // rollups; while it loads (or errors) the chart falls back to flat bars.
  const dayModelSnap = useGatewayUsage({
    orgId: org.id,
    scope: apiScope,
    groupBy: "day_model",
    from: range.from ?? undefined,
    to: range.to
  });
  const modelSnap = useGatewayUsage({
    orgId: org.id,
    scope: apiScope,
    groupBy: "model",
    from: range.from ?? undefined,
    to: range.to
  });
  // The member breakdown belongs to the Workspace view only — Personal shows
  // just your own usage and the contribution graph (the product owner). Both reads stay
  // idle outside it. Visibility never depends on these reads succeeding: a
  // failed roster read only degrades the names to raw member ids.
  const showMembers = canSeeWorkspace && scope === "workspace";
  const memberSnap = useGatewayUsage(
    showMembers
      ? {
          orgId: org.id,
          scope: "org",
          groupBy: "member",
          from: range.from ?? undefined,
          to: range.to
        }
      : null
  );
  const memberDirectory = useMemberDirectory(showMembers ? org.id : null);

  const series = useMemo(
    () => (daySnap.rows === null ? null : dailySeries(daySnap.rows, range, metric)),
    [daySnap.rows, range.from, range.to, metric]
  );
  // Top-8-plus-Other per-day stacks; day totals stay anchored to the same
  // group_by=day rows as the headline, so the stack always sums to it. Named
  // series rank from the group_by=model rollup (server-aggregated over the
  // full range), so the per-day read's row cap cannot demote a historically
  // dominant model out of the legend. While the per-model read is in flight
  // (a period or scope change refetches it, the day axis re-cuts instantly)
  // or errored, the chart falls back to flat bars — stale cells would paint
  // newly exposed days as all-Other otherwise.
  const stacks = useMemo(
    () =>
      daySnap.rows === null || dayModelSnap.rows === null
        ? null
        : dailyModelStacks(daySnap.rows, dayModelSnap.rows, range, {
            rankRows: modelSnap.rows ?? undefined
          }),
    [daySnap.rows, dayModelSnap.rows, modelSnap.rows, range.from, range.to]
  );
  // Both reads must be settled: the ranking rollup refetches independently of
  // the per-day cells, and a retained-but-stale (or errored-and-retained)
  // ranking would order the legend for the previous period or scope.
  const stacksFresh =
    !dayModelSnap.loading &&
    dayModelSnap.error === null &&
    !modelSnap.loading &&
    modelSnap.error === null;
  // The rail beside the chart wears the chart's exact colors: one assignment
  // derived from the stack's series order, so the two can never diverge
  // ("color-match the list to the chart" — the product owner). Null while the stacks are
  // stale or absent; the rail then falls back to its neutral accent bars,
  // matching the chart's flat mode.
  const modelColors = useMemo(
    () =>
      stacksFresh && stacks !== null
        ? new Map(
            stacks.series.map((entry, index) => [
              entry.key,
              seriesColor(entry.key, index, MODEL_SERIES_PALETTE)
            ])
          )
        : null,
    [stacks, stacksFresh]
  );
  // Insights carries the period over so "View all" ranks the same window it
  // left (Greptile on #694); its canonical 7d URL stays parameterless.
  const insightsWindow = insightsWindowFor(period);
  const insightsHref =
    insightsWindow === "7d" ? insightsPath() : `${insightsPath()}?window=${insightsWindow}`;
  const total = series === null ? null : series.reduce((sum, point) => sum + point.value, 0);
  const previousTotal =
    daySnap.rows === null || previousRange === null
      ? null
      : sumMetric(rowsInRange(daySnap.rows, previousRange), metric);
  const delta =
    total === null || previousTotal === null ? null : deltaPercent(total, previousTotal);

  // The activity graph's own fixed 90-day window (personal scope only), never
  // the selected period.
  const activitySeries = useMemo(
    () => (daySnap.rows === null ? null : dailySeries(daySnap.rows, activityRange, metric)),
    [daySnap.rows, activityRange, metric]
  );
  const activity = activitySeries === null ? null : activityStats(activitySeries);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {canSeeWorkspace && (
          <SlidingTabs
            activeKey={scope}
            ariaLabel="Scope"
            onPick={(key) => setScope(key as OverviewScope)}
            tabs={SCOPE_TABS}
          />
        )}
        <SlidingTabs
          activeKey={metric}
          ariaLabel="Metric"
          onPick={(key) => setMetric(key as UsageMetric)}
          tabs={USAGE_METRICS.map(({ key, label }) => ({ key, label }))}
        />
        <div className="ml-auto">
          <SlidingTabs
            activeKey={period}
            ariaLabel="Period"
            onPick={(key) => setPeriod(key as UsagePeriod)}
            tabs={USAGE_PERIODS.map(({ key, label }) => ({ key, label }))}
          />
        </div>
      </div>

      {daySnap.error !== null && daySnap.rows === null ? (
        <ErrorTile message={daySnap.error} title="Usage is unavailable" />
      ) : (
        // The usage summary is the page's hero: this row grows to take the free
        // vertical space (flex-1) so the per-day chart owns it edge to edge
        // instead of hugging the top of a short card with dead space below
        // (the product owner). Flex (not grid) so the cards stretch to the full row height
        // and the chart's flex-1 well actually fills; the row stacks on mobile
        // and sits 2:1 (summary:top-models) on desktop. The right rail stretches
        // alongside it. (The extracted UsageSummarySection is kept for the admin
        // Telemetry panel; the Overview renders the hero layout inline.)
        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <section
            className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border border-line bg-surface p-[18px] md:flex-[2]"
            data-testid="usage-summary"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="mono-label">
                {scope === "workspace" ? "Workspace usage" : "Your usage"}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]">
                {delta !== null && (
                  <span className="text-muted" data-testid="usage-delta">
                    {formatDeltaPercent(delta)} vs {PERIOD_NOUN[period]}
                  </span>
                )}
                <Link className="text-accent hover:underline" href={insightsHref}>
                  View full activity
                </Link>
              </span>
            </div>
            {total === null || series === null ? (
              <Shimmer className="min-h-[160px] flex-1" />
            ) : (
              <>
                <p className="m-0 font-mono text-2xl font-semibold" data-testid="usage-total">
                  {formatMetricValue(metric, total)}
                </p>
                {/* The chart fills the rest of the hero card; DailyUsageChart
                    measures this box, so it scales with the viewport. */}
                <div className="min-h-[160px] flex-1">
                  <DailyUsageChart
                    metric={metric}
                    series={series}
                    stacks={stacksFresh ? (stacks ?? undefined) : undefined}
                  />
                </div>
              </>
            )}
          </section>
          <TopModels
            colors={modelColors}
            error={modelSnap.error}
            knownSlugs={knownModelSlugs}
            loading={modelSnap.loading}
            metric={metric}
            rows={modelSnap.rows}
            viewAllHref={insightsHref}
          />
        </div>
      )}

      {scope === "personal" ? (
        <ActivitySection activity={activity} metric={metric} series={activitySeries} />
      ) : (
        <MembersBreakdown
          directory={memberDirectory}
          error={memberSnap.error}
          loading={memberSnap.loading}
          metric={metric}
          rows={memberSnap.rows}
        />
      )}

      {/* A self-contained summary of the org's active keys so a signed-in
          landing (and the YC "Go to Overview" flow) always shows one; full key
          management lives on /api-keys. The platform-credit balance card and
          the per-provider credit accounts that once sat here are dropped , 
          credit balances live on /credits now (the product owner, round-2/3). */}
      <ApiKeysSummary orgId={org.id} />
    </div>
  );
}

/**
 * The headline usage card: the period total in the chosen metric with the
 * per-day chart and the previous-period delta. Shared verbatim between the
 * Overview (per-org) and the admin Telemetry panel (platform-wide and
 * per-org drilldown); only the label, delta wording, and testid prefix
 * differ.
 */
export function UsageSummarySection({
  label,
  delta,
  deltaSuffix,
  metric,
  total,
  series,
  testIdPrefix
}: {
  label: string;
  delta: number | null;
  deltaSuffix: string;
  metric: UsageMetric;
  total: number | null;
  series: DailyPoint[] | null;
  /** "usage" (Overview) or "admin-usage" (Telemetry) — pins the test hooks. */
  testIdPrefix: string;
}) {
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-[18px]"
      data-testid={`${testIdPrefix}-summary`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="mono-label">{label}</span>
        {delta !== null && (
          <span className="text-[12px] text-muted" data-testid={`${testIdPrefix}-delta`}>
            {formatDeltaPercent(delta)} {deltaSuffix}
          </span>
        )}
      </div>
      {total === null || series === null ? (
        <Shimmer className="h-[176px]" />
      ) : (
        <>
          <p
            className="m-0 font-mono text-2xl font-semibold"
            data-testid={`${testIdPrefix}-total`}
          >
            {formatMetricValue(metric, total)}
          </p>
          <DailyUsageChart metric={metric} series={series} />
        </>
      )}
    </section>
  );
}

/**
 * The fixed-90-day contribution graph with a compact one-line stat summary.
 * Personal scope only here; the admin Telemetry panel reuses it for the
 * platform-wide and per-org activity views.
 */
export function ActivitySection({
  series,
  activity,
  metric
}: {
  series: DailyPoint[] | null;
  activity: ActivityStats | null;
  metric: UsageMetric;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]"
      data-testid="activity-section"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="mono-label">Activity</span>
        {activity !== null && (
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-muted">
            <span className="text-ink-faint">Last 90 days</span>
            <ActivityStat label="longest streak" value={`${activity.longestStreakDays}d`} />
            <ActivityStat label="avg / day" value={formatAverage(metric, activity.averagePerDay)} />
            <ActivityStat label="avg / week" value={formatAverage(metric, activity.averagePerWeek)} />
            <ActivityStat label="total" value={formatMetricValue(metric, activity.total)} />
          </span>
        )}
      </div>
      {series === null ? (
        <Shimmer className="h-[140px]" />
      ) : (
        <ContributionGraph metric={metric} series={series} />
      )}
    </section>
  );
}

/** One inline "value label" activity figure in the compact stat row. */
function ActivityStat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="font-mono font-medium text-ink">{value}</span>{" "}
      <span className="text-muted-2">{label}</span>
    </span>
  );
}

/** Averages are fractional; sub-unit token/request figures keep one decimal. */
function formatAverage(metric: UsageMetric, value: number): string {
  if (metric === "spend") {
    return formatMetricValue(metric, value);
  }
  return formatMetricValue(metric, Math.round(value * 10) / 10);
}

// How many rows the card shows: few enough to fit the hero row without an
// inner scroll region on realistic viewports ("top models by spend now has a
// scroll which we should not have" — the product owner); the header's "View all" link
// carries the rest to Insights.
const TOP_MODELS_VISIBLE = 6;

/**
 * Top model aliases by the chosen metric. Typed against the metric floor so
 * the Overview's per-org rows and the admin panel's platform-wide rows both
 * fit; only the alias dimension is read.
 */
export function TopModels({
  rows,
  metric,
  loading,
  error,
  knownSlugs,
  colors,
  viewAllHref = insightsPath()
}: {
  rows: (UsageMetricRow & { alias: string | null })[] | null;
  metric: UsageMetric;
  loading: boolean;
  error: string | null;
  /**
   * Routable catalog slugs gating the row links; null or omitted (catalog
   * unavailable, or the admin panel's platform-wide rows) fails open to
   * linking every named alias.
   */
  knownSlugs?: string[] | null;
  /**
   * alias → the hero chart's series color, derived from the SAME stack
   * assignment the chart paints (OverviewView), so a row's bar reads as its
   * segments; an alias outside the map wears the chart's Other gray. Null or
   * omitted (chart in flat mode, or the admin panel) keeps the accent bars.
   */
  colors?: Map<string, string> | null;
  /** Where "View all" lands; the Overview carries its period's window over. */
  viewAllHref?: string;
}) {
  const linkable = new Set(knownSlugs ?? []);
  const shouldLink = (alias: string) =>
    alias !== "unknown" && (knownSlugs == null || linkable.has(alias));
  const barColor = (alias: string): string | undefined =>
    colors == null
      ? undefined
      : (colors.get(alias) ?? seriesColor(OTHER_SERIES_KEY, 0, MODEL_SERIES_PALETTE));
  // The full spread of active models this period; the card shows the leading
  // slice and links the rest out to the Insights dashboard. The slice is the
  // whole card — it never grows an inner scroll region (the product owner), so it is
  // sized to fit the hero row rather than to the chart's 8 named series.
  const all = rows === null ? null : topGroups(rows, metric, (row) => row.alias ?? "unknown", rows.length);
  const top = all === null ? null : all.slice(0, TOP_MODELS_VISIBLE);
  const max = top !== null && top.length > 0 ? top[0].value : 0;
  return (
    <section
      className="flex min-h-0 shrink-0 flex-col gap-3 rounded-lg border border-line bg-surface p-[18px] md:flex-1"
      data-testid="top-models"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="mono-label">Top models by {metric === "spend" ? "spend" : metric}</span>
        {all !== null && all.length > TOP_MODELS_VISIBLE && (
          <Link className="text-[12px] text-accent hover:underline" href={viewAllHref}>
            View all ({all.length})
          </Link>
        )}
      </div>
      {top === null && error !== null && (
        <ErrorTile message={error} title="Top models are unavailable" />
      )}
      {top === null && error === null && loading && <Shimmer className="min-h-[160px] flex-1" />}
      {top !== null && top.length === 0 && (
        <p className="m-0 text-[12px] text-muted-2">No requests in this period.</p>
      )}
      {top !== null && top.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {top.map((model) => {
            const body = (
              <>
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <ModelIcon icon={aliasIconKey(model.label)} name={model.label} size={14} />
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono">
                      {model.label}
                    </span>
                  </span>
                  <span className="shrink-0 text-muted">
                    {formatMetricValue(metric, model.value)}
                  </span>
                </div>
                {/* Share bar: widths are proportions of the leader, an exact
                    content bound rather than page structure. The bar wears the
                    model's chart series color when the stacked hero is live. */}
                <div className="h-1 w-full rounded-full bg-surface-subtle">
                  <div
                    className={`h-1 rounded-full${colors == null ? " bg-accent" : ""}`}
                    data-testid="top-model-bar"
                    style={{
                      width: `${Math.max((model.value / max) * 100, 2)}%`,
                      backgroundColor: barColor(model.label)
                    }}
                  />
                </div>
              </>
            );
            // A rollup alias IS the routable model slug, so a row links out to
            // the model's catalog page — but only while the catalog still
            // carries that slug (a delisted model's history would 404); the
            // null-alias fold has none to visit.
            return (
              <li key={model.label}>
                {shouldLink(model.label) ? (
                  <Link
                    className="-mx-1.5 flex flex-col gap-1 rounded-[var(--radius-md)] px-1.5 py-1 hover:bg-surface-subtle"
                    href={modelPath(encodeURIComponent(model.label))}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex flex-col gap-1 py-1">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function MembersBreakdown({
  rows,
  metric,
  directory,
  loading,
  error,
  className
}: {
  rows: GatewayUsageRow[] | null;
  metric: UsageMetric;
  directory: MemberDirectory | null;
  loading: boolean;
  error: string | null;
  className?: string;
}) {
  return (
    <UsageBreakdownTable
      activeNoun="member"
      className={className}
      columnHeader="Member"
      emptyText="No member activity in this period."
      error={error}
      loading={loading}
      metric={metric}
      renderName={(row) =>
        row.user_id === null ? "Unattributed keys" : (directory?.get(row.user_id) ?? row.user_id)
      }
      rowKey={(row) => row.user_id ?? "unattributed"}
      rows={rows}
      testId="members-breakdown"
      title="Members"
    />
  );
}

/** Compact UTC day for a key's created timestamp. */
function keyDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

/**
 * A summary of the org's active API keys: how many are live, when the newest
 * was created, and a compact masked table (name, `xpl_ab12cd34…f2e1` identity,
 * created) of the most recent few, with a link out to full management. Reads
 * the same GET /api/keys the settings page's list is backed by so the two
 * never drift; the plaintext secret only ever exists in the mint response, so
 * the stored prefix and last-4 suffix are all this can ever show — which is
 * why there is deliberately no copy affordance here. Scoped to the active org
 * by its id.
 */
function ApiKeysSummary({ orgId }: { orgId: string }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/keys?orgId=${encodeURIComponent(orgId)}`, {
          cache: "no-store"
        });
        const payload = (await response.json().catch(() => null)) as
          | { keys?: ApiKeyRow[]; error?: unknown }
          | null;
        if (!response.ok) {
          throw new Error(
            typeof payload?.error === "string" ? payload.error : "Unable to load your API keys."
          );
        }
        if (active) {
          setKeys(payload?.keys ?? []);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Unable to load your API keys.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [orgId]);

  // The GET returns active keys newest-first; the freshest is the head.
  const newest = keys !== null && keys.length > 0 ? keys[0] : null;
  const shown = keys?.slice(0, 4) ?? [];

  return (
    <section
      className="flex shrink-0 flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]"
      data-testid="your-api-key-section"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="mono-label">API keys</span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]">
          {keys !== null && keys.length > 0 && (
            <span className="text-muted">
              {keys.length === 1 ? "1 active key" : `${keys.length} active keys`}
              {newest !== null && ` · newest ${keyDateLabel(newest.created_at)}`}
            </span>
          )}
          <Link className="text-accent hover:underline" href={apiKeysPath()}>
            Manage keys
          </Link>
        </span>
      </div>
      {error !== null && <ErrorTile message={error} title="API keys are unavailable" />}
      {error === null && loading && <Shimmer className="h-[44px]" />}
      {error === null && !loading && newest === null && (
        <p className="m-0 text-[13px] text-muted">
          No active API keys yet.{" "}
          <Link className="text-accent hover:underline" href={apiKeysPath()}>
            Create one
          </Link>{" "}
          to authenticate your code and the wmo CLI.
        </p>
      )}
      {error === null && !loading && newest !== null && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25">
              <th className="py-1.5 font-medium">Name</th>
              <th className="py-1.5 font-medium">Key</th>
              <th className="py-1.5 text-right font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((key) => (
              <tr className="border-t border-line" key={key.id}>
                <td className="max-w-0 overflow-hidden text-ellipsis whitespace-nowrap py-2 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <KeyRound aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
                    {key.name}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-muted">
                  {formatKeyIdentity(key.key_prefix, key.key_suffix)}
                </td>
                <td className="py-2 text-right font-mono text-muted">
                  {keyDateLabel(key.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
