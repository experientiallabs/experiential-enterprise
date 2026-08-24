"use client";

import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";

import {
  ActivitySection,
  TopModels,
  UsageSummarySection
} from "@/components/overview/OverviewView";
import { UsageBreakdownTable } from "@/components/overview/UsageBreakdownTable";
import {
  platformUsageUrl,
  useGatewayUsage,
  useUsageRows
} from "@/components/overview/use-gateway-usage";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import {
  activityStats,
  addDays,
  dailySeries,
  deltaPercent,
  periodRange,
  previousPeriodRange,
  rowsInRange,
  sumMetric,
  USAGE_METRICS,
  USAGE_PERIODS,
  utcToday,
  type DayRange,
  type PlatformUsageRow,
  type UsageMetric,
  type UsageMetricRow,
  type UsagePeriod
} from "@/lib/gateway-usage";

type AdminTelemetryOrg = { id: string; name: string };

// The same fixed window the Overview's activity graph uses; the period
// toggle governs the usage summary, top models, and the org breakdown only.
const ACTIVITY_DAYS = 90;

/**
 * The admin Telemetry section: the Overview page's usage views, lifted to the
 * operator altitude. The default scope is the platform total (every org
 * summed, from the gated admin usage read); the per-org breakdown table
 * drills into one organization, whose series comes through the same tenant
 * endpoint the Overview uses (platform admins pass its org gate). The chart,
 * top-models, activity, and breakdown sections are the Overview's own
 * components; all period/metric math is the shared lib/gateway-usage module.
 */
export function AdminTelemetryPanel({ orgs }: { orgs: AdminTelemetryOrg[] }) {
  const [metric, setMetric] = useState<UsageMetric>("spend");
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  // Pinned per mount: a page open across midnight UTC keeps one consistent
  // "today" rather than re-cutting every period mid-interaction.
  const [today] = useState(() => utcToday());

  const range = periodRange(period, today);
  const previousRange = previousPeriodRange(period, today);
  const activityRange = useMemo(
    () => ({ from: addDays(today, -(ACTIVITY_DAYS - 1)), to: today }),
    [today]
  );
  const orgNames = useMemo(() => new Map(orgs.map((org) => [org.id, org.name])), [orgs]);

  // The platform reads stay mounted while drilled into an org: their urls
  // never change on drilldown, so backing out re-renders the cached rows
  // instead of refetching the widest (all-time per-day) read. The all-time
  // series is fetched once and every period cut derives client-side, exactly
  // like the Overview. The breakdown doubles as the org switcher — always
  // the org-wide roll-up bounded to the period.
  const platformDaySnap = useUsageRows<PlatformUsageRow>(platformUsageUrl({ groupBy: "day" }));
  const platformModelSnap = useUsageRows<PlatformUsageRow>(
    platformUsageUrl({ groupBy: "model", from: range.from ?? undefined, to: range.to })
  );
  const breakdownSnap = useUsageRows<PlatformUsageRow>(
    platformUsageUrl({ groupBy: "org", from: range.from ?? undefined, to: range.to })
  );

  const selectedOrgName =
    selectedOrgId === null ? null : (orgNames.get(selectedOrgId) ?? selectedOrgId);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {selectedOrgId !== null && (
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 py-1 text-[12px] text-foreground/70 hover:text-foreground"
            onClick={() => setSelectedOrgId(null)}
            type="button"
          >
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
            All organizations
          </button>
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

      {selectedOrgId === null ? (
        <ScopeUsageViews
          activityRange={activityRange}
          dayError={platformDaySnap.error}
          dayRows={platformDaySnap.rows}
          label="All organizations"
          metric={metric}
          modelError={platformModelSnap.error}
          modelLoading={platformModelSnap.loading}
          modelRows={platformModelSnap.rows}
          previousRange={previousRange}
          range={range}
        />
      ) : (
        // Keyed by org id: switching orgs from the breakdown mounts fresh
        // reads, so one org's rows are never rendered (or, after a failed
        // fetch, stranded) under another org's name.
        <OrgScopeUsage
          activityRange={activityRange}
          key={selectedOrgId}
          label={selectedOrgName ?? selectedOrgId}
          metric={metric}
          orgId={selectedOrgId}
          previousRange={previousRange}
          range={range}
        />
      )}

      <OrgsBreakdown
        error={breakdownSnap.error}
        loading={breakdownSnap.loading}
        metric={metric}
        onPick={setSelectedOrgId}
        orgNames={orgNames}
        rows={breakdownSnap.rows}
        selectedOrgId={selectedOrgId}
      />
    </div>
  );
}

/**
 * One org's drilldown reads through the tenant endpoint (platform admins
 * pass its org gate). A separate component so the panel can key it by org
 * id — each drilldown gets its own snapshots instead of inheriting the
 * previous org's rows while the new fetch is in flight.
 */
function OrgScopeUsage({
  orgId,
  label,
  metric,
  range,
  previousRange,
  activityRange
}: {
  orgId: string;
  label: string;
  metric: UsageMetric;
  range: DayRange;
  previousRange: DayRange | null;
  activityRange: DayRange;
}) {
  const daySnap = useGatewayUsage({ orgId, scope: "org", groupBy: "day" });
  const modelSnap = useGatewayUsage({
    orgId,
    scope: "org",
    groupBy: "model",
    from: range.from ?? undefined,
    to: range.to
  });
  return (
    <ScopeUsageViews
      activityRange={activityRange}
      dayError={daySnap.error}
      dayRows={daySnap.rows}
      label={label}
      metric={metric}
      modelError={modelSnap.error}
      modelLoading={modelSnap.loading}
      modelRows={modelSnap.rows}
      previousRange={previousRange}
      range={range}
    />
  );
}

/**
 * The summary + top-models grid and the activity graph for one scope
 * (platform-wide or a drilled-into org), all derived from the scope's
 * all-time day series with the shared lib/gateway-usage math. Typed against
 * the metric floor: the platform and tenant rows differ only in their
 * grouped dimension, which these views never read.
 */
function ScopeUsageViews({
  label,
  dayRows,
  dayError,
  modelRows,
  modelLoading,
  modelError,
  metric,
  range,
  previousRange,
  activityRange
}: {
  label: string;
  dayRows: (UsageMetricRow & { day: string | null })[] | null;
  dayError: string | null;
  modelRows: (UsageMetricRow & { alias: string | null })[] | null;
  modelLoading: boolean;
  modelError: string | null;
  metric: UsageMetric;
  range: DayRange;
  previousRange: DayRange | null;
  activityRange: DayRange;
}) {
  const series = useMemo(
    () => (dayRows === null ? null : dailySeries(dayRows, range, metric)),
    [dayRows, range.from, range.to, metric]
  );
  const total = series === null ? null : series.reduce((sum, point) => sum + point.value, 0);
  const previousTotal =
    dayRows === null || previousRange === null
      ? null
      : sumMetric(rowsInRange(dayRows, previousRange), metric);
  const delta =
    total === null || previousTotal === null ? null : deltaPercent(total, previousTotal);

  const activitySeries = useMemo(
    () => (dayRows === null ? null : dailySeries(dayRows, activityRange, metric)),
    [dayRows, activityRange, metric]
  );
  const activity = activitySeries === null ? null : activityStats(activitySeries);

  return (
    <>
      {dayError !== null && dayRows === null ? (
        <ErrorTile message={dayError} title="Usage is unavailable" />
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <UsageSummarySection
            delta={delta}
            deltaSuffix="vs previous period"
            label={label}
            metric={metric}
            series={series}
            testIdPrefix="admin-usage"
            total={total}
          />
          <TopModels
            error={modelError}
            loading={modelLoading}
            metric={metric}
            rows={modelRows}
          />
        </div>
      )}
      <ActivitySection activity={activity} metric={metric} series={activitySeries} />
    </>
  );
}

/**
 * Per-org usage for the period, spend-leaders first — the platform scope's
 * breakdown and the drilldown's org switcher in one table (the shared
 * Overview breakdown, with the org dimension). An org missing from the
 * administered roster (deleted mid-period) falls back to its raw id.
 */
function OrgsBreakdown({
  rows,
  metric,
  orgNames,
  selectedOrgId,
  onPick,
  loading,
  error
}: {
  rows: PlatformUsageRow[] | null;
  metric: UsageMetric;
  orgNames: Map<string, string>;
  selectedOrgId: string | null;
  onPick: (orgId: string) => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <UsageBreakdownTable
      activeNoun="org"
      className="min-h-0 flex-1"
      columnHeader="Organization"
      emptyText="No organization activity in this period."
      error={error}
      isSelected={(row) => row.org_id !== null && row.org_id === selectedOrgId}
      loading={loading}
      metric={metric}
      renderName={(row) => {
        // Bound to a const so the non-null narrowing flows into the click
        // handler's closure.
        const orgId = row.org_id;
        return orgId === null ? (
          "Unknown organization"
        ) : (
          <button
            className="cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] text-[13px] text-accent hover:underline"
            onClick={() => onPick(orgId)}
            type="button"
          >
            {orgNames.get(orgId) ?? orgId}
          </button>
        );
      }}
      rowKey={(row) => row.org_id ?? "unknown"}
      rows={rows}
      testId="orgs-breakdown"
      title="Organizations"
    />
  );
}
