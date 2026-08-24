"use client";

import { useState } from "react";

import { RankedList } from "@/components/activity/RankedList";
import { StackedBarChart } from "@/components/activity/StackedBarChart";
import { InsightsView } from "@/components/insights/insights-view";
import { ModelIcon, ProviderLogo } from "@/components/models-catalog/model-icon";
import { SpendChart } from "@/components/telemetry-page/spend-chart";
import { StatTile } from "@/components/ui/StatTile";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import {
  blendedPerMillionUsd,
  modelUsageSeries,
  providerRows,
  topKeysBySpend,
  topModelsBySpend
} from "@/lib/activity-usage";
import { allSpendUsd, laneSpendSeries, usageTotals } from "@/lib/gateway-telemetry";
import { formatTokens } from "@/lib/format";
import { aliasIconKey } from "@/lib/model-brand";
import { formatCostUsd, formatPerMillionUsd } from "@/lib/money";
import { insightsPath, modelPath } from "@/lib/routes";
import type {
  ServingWindow,
  Suggestion,
  UsageByKey,
  UsageByPrompt,
  UsageByProvider,
  UsageTimeseries
} from "@/lib/types";

const WINDOW_TABS: readonly { key: ServingWindow; label: string }[] = [
  { key: "24h", label: "Past 24h" },
  { key: "7d", label: "Past 7 days" },
  { key: "30d", label: "Past 30 days" }
];

type ActivityTab = "overview" | "intelligence";

const VIEW_TABS = [
  { key: "overview", label: "Overview" },
  { key: "intelligence", label: "Intelligence" }
] as const;

type ActivityViewProps = {
  orgId: string;
  window: ServingWindow;
  /** Pinned server clock so the contiguous bucket axis matches the data. */
  nowMs: number;
  timeseries: UsageTimeseries;
  byKey: UsageByKey;
  byProvider: UsageByProvider;
  byPrompt: UsageByPrompt;
  suggestions: Suggestion[];
  /** Whether the viewer may flip the org-wide prompt-capture opt-in. */
  canManagePromptCapture: boolean;
  /**
   * The catalog's routable slugs (lib/model-links), gating which top-model
   * rows link out to /models/{slug}; null (catalog unavailable) fails open
   * to linking everything.
   */
  knownModelSlugs: string[] | null;
};

const requestsFormat = (value: number): string => Math.round(value).toLocaleString("en-US");

/**
 * The Insights dashboard: every deep usage graph shown at once (OpenRouter
 * Activity-style), plus the natural-language Intelligence query folded in as a
 * second tab. All figures derive from the org's OWN gateway aggregates for the
 * selected window, so nothing renders that is not real. The window selector
 * drives the whole page through the URL (server re-fetch); the Overview and
 * Intelligence tabs switch in place.
 */
export function ActivityView({
  orgId,
  window: windowKey,
  nowMs,
  timeseries,
  byKey,
  byProvider,
  byPrompt,
  suggestions,
  knownModelSlugs,
  canManagePromptCapture
}: ActivityViewProps) {
  const [tab, setTab] = useState<ActivityTab>("overview");
  const linkable = new Set(knownModelSlugs ?? []);
  const modelHref = (alias: string): string | null =>
    alias !== "" && (knownModelSlugs === null || linkable.has(alias))
      ? modelPath(encodeURIComponent(alias))
      : null;

  const totals = usageTotals(timeseries.buckets);
  const allSpend = allSpendUsd(totals);
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const blended = blendedPerMillionUsd(allSpend, totalTokens);
  const bucketSeconds = timeseries.bucket_seconds;

  const spendByModel = modelUsageSeries(timeseries.buckets, bucketSeconds, windowKey, nowMs, "spend");
  const requestsByModel = modelUsageSeries(
    timeseries.buckets,
    bucketSeconds,
    windowKey,
    nowMs,
    "requests"
  );
  const laneSpend = laneSpendSeries(timeseries.buckets, bucketSeconds, windowKey, nowMs);
  const topModels = topModelsBySpend(timeseries.buckets, 6);
  const topKeys = topKeysBySpend(byKey.keys, 6);
  const providers = providerRows(byProvider.providers, 6);

  const windowTabs = WINDOW_TABS.map((entry) => ({
    key: entry.key,
    label: entry.label,
    href: entry.key === "7d" ? insightsPath() : `${insightsPath()}?window=${entry.key}`
  }));

  return (
    <div className="flex min-h-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SlidingTabs
          activeKey={tab}
          ariaLabel="Insights view"
          onPick={(key) => setTab(key as ActivityTab)}
          tabs={VIEW_TABS.map((entry) => ({ key: entry.key, label: entry.label }))}
        />
        {tab === "overview" && (
          <SlidingTabs activeKey={windowKey} ariaLabel="Window" tabs={windowTabs} />
        )}
      </div>

      {tab === "overview" ? (
        <div className="flex flex-col gap-4">
          <section
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            data-testid="activity-stat-cards"
          >
            <StatTile label="Total spend" value={formatCostUsd(allSpend)} detail="Credits plus BYOK est." />
            <StatTile label="Requests" value={requestsFormat(totals.requestCount)} />
            <StatTile label="Token volume" value={formatTokens(totalTokens)} />
            <StatTile
              label="Blended $/1M"
              value={blended === null ? "—" : formatPerMillionUsd(blended * 1_000_000)}
              detail="All spend per million tokens"
            />
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard hint="All-spend per model over the window, stacked." title="Spend by model">
              <StackedBarChart
                data={spendByModel}
                format={formatCostUsd}
                unitLabel="dollars"
                window={windowKey}
              />
            </ChartCard>
            <ChartCard hint="Requests per model over the window, stacked." title="Request volume by model">
              <StackedBarChart
                data={requestsByModel}
                format={requestsFormat}
                unitLabel="requests"
                window={windowKey}
              />
            </ChartCard>
          </div>

          <ChartCard
            hint="Platform credits (charged) versus BYOK (never-charged pass-through estimate)."
            title="Credits vs BYOK"
          >
            <SpendChart data={laneSpend} window={windowKey} />
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-3">
            <ListCard hint="Your biggest spenders this window." title="Top models by spend">
              {/* A rollup model key IS the routable model slug, so rows link
                  out to the catalog page while the catalog still carries the
                  slug; the unattributed fold ("" key, displayed as
                  "(unattributed)") has none to visit. */}
              <RankedList
                emptyLabel="No spend in this window."
                format={formatCostUsd}
                href={(row) => modelHref(row.key)}
                renderLeading={(row) =>
                  row.key === "" ? null : (
                    <ModelIcon icon={aliasIconKey(row.key)} name={row.label} size={13} />
                  )
                }
                rows={topModels}
              />
            </ListCard>
            <ListCard hint="The API keys (agents) driving spend." title="Top API keys">
              <RankedList emptyLabel="No key activity in this window." format={formatCostUsd} rows={topKeys} />
            </ListCard>
            <ListCard hint="Where your winning requests were served." title="Providers">
              <RankedList
                emptyLabel="No provider activity in this window."
                format={formatCostUsd}
                renderLeading={(row) =>
                  row.key === "undispatched" ? null : <ProviderLogo provider={row.key} size={13} />
                }
                rows={providers}
              />
            </ListCard>
          </div>

          {/* Cache-hit-rate, the reasoning/prompt/completion token breakdown, and
              top apps are intentionally not shown: the gateway exposes those only
              per request, never as a windowed aggregate (see lib/activity-usage.ts).
              They land here once a windowed aggregate exists. */}
        </div>
      ) : (
        <InsightsView
          byKey={byKey}
          byPrompt={byPrompt}
          canManagePromptCapture={canManagePromptCapture}
          orgId={orgId}
          suggestions={suggestions}
          timeseries={timeseries}
        />
      )}
    </div>
  );
}

function ChartCard({
  title,
  hint,
  children
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <h3 className="m-0 text-[13px] font-semibold text-ink">{title}</h3>
      <p className="m-0 mb-2 text-[11px] text-muted-2">{hint}</p>
      {children}
    </section>
  );
}

function ListCard({
  title,
  hint,
  children
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <h3 className="m-0 text-[13px] font-semibold text-ink">{title}</h3>
      <p className="m-0 mb-2 text-[11px] text-muted-2">{hint}</p>
      {children}
    </section>
  );
}
