"use client";

import { useEffect, useState } from "react";

import { SpendChart } from "@/components/telemetry-page/spend-chart";
import {
  totalSpendSeries,
  usageTimeseriesQueryString,
  type SpendChartData
} from "@/lib/gateway-telemetry";
import { formatCostUsd, formatSignedCostUsd } from "@/lib/money";
import { MODEL_PROVIDERS, modelProviderLabel, type ModelProvider } from "@/lib/model-providers";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import type {
  OrgUsageReport,
  ProviderUsage,
  ServingWindow,
  UsageByProvider,
  UsageTimeseries
} from "@/lib/types";

const WINDOWS: readonly { key: ServingWindow; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" }
];

const DEFAULT_WINDOW: ServingWindow = "7d";

type SpendOverviewCardProps = {
  /** Null renders the signed-out card: empty states, zero fetches. */
  orgId: string | null;
  /** The live counters (polled by CreditsView): all-time spend, credits left. */
  report: OrgUsageReport;
};

/**
 * The credits page's one spend view (the product owner, credits redesign 2026-08-22: the
 * old spend/balances/meters fragmentation goes away). Platform-funded and BYOK
 * dollars are ALWAYS combined: one headline strip (all-time spend, credits
 * left), one all-spend-over-time graph for the picked window, and the same
 * window's spend per provider under it. Signed-out renders the frame with
 * empty states and fetches nothing.
 */
export function SpendOverviewCard({ orgId, report }: SpendOverviewCardProps) {
  const [window_, setWindow] = useState<ServingWindow>(DEFAULT_WINDOW);
  const [timeseries, setTimeseries] = useState<UsageTimeseries | null>(null);
  const [providers, setProviders] = useState<ProviderUsage[] | null>(
    orgId === null ? [] : null
  );

  useEffect(() => {
    if (orgId === null) {
      return;
    }
    let cancelled = false;
    const encoded = encodeURIComponent(orgId);
    const load = async () => {
      try {
        const [seriesResponse, providersResponse] = await Promise.all([
          fetch(
            `/api/orgs/${encoded}/usage/timeseries?${usageTimeseriesQueryString({ window: window_ })}`,
            { cache: "no-store" }
          ),
          fetch(`/api/orgs/${encoded}/usage/by-provider?window=${window_}`, {
            cache: "no-store"
          })
        ]);
        if (cancelled) {
          return;
        }
        if (seriesResponse.ok) {
          setTimeseries((await seriesResponse.json()) as UsageTimeseries);
        }
        if (providersResponse.ok) {
          const payload = (await providersResponse.json()) as UsageByProvider;
          setProviders(payload.providers);
        }
      } catch {
        // Transient failure: the card keeps its last (or empty) state.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [orgId, window_]);

  const { credit } = report;
  const chartData: SpendChartData | null =
    timeseries === null
      ? null
      : totalSpendSeries(timeseries.buckets, timeseries.bucket_seconds, window_, Date.now());
  const hasWindowSpend =
    chartData !== null && chartData.series[0].points.some((value) => value > 0);

  return (
    <section
      className="flex flex-col gap-4 border border-line rounded-lg bg-surface p-[18px]"
      data-testid="spend-overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <HeadlineStat label="Spend" value={formatCostUsd(credit.spend_usd)} />
          <HeadlineStat
            detail={`of ${formatCostUsd(credit.credit_granted_usd)}`}
            label="Credits left"
            // A negative balance renders honestly (never clamped) and in the
            // warning color: one request may overdraw, and hiding that would
            // contradict the 402 the next request gets.
            value={formatSignedCostUsd(credit.credit_balance_usd)}
            warn={credit.credit_balance_usd < 0}
          />
        </div>
        <SlidingTabs
          activeKey={window_}
          ariaLabel="Spend window"
          onPick={(key) => setWindow(key as ServingWindow)}
          tabs={WINDOWS}
        />
      </div>
      {orgId === null || (chartData !== null && !hasWindowSpend && providersEmpty(providers)) ? (
        <p className="m-0 text-[13px] leading-relaxed text-muted" data-testid="spend-empty">
          No metered spend yet. As your gateway traffic runs, spend over time and per provider
          appears here.
        </p>
      ) : chartData === null ? (
        <div aria-hidden className="h-[180px] w-full animate-pulse rounded-md bg-foreground/[0.04]" />
      ) : (
        <SpendChart data={chartData} window={window_} />
      )}
      {orgId !== null && <ProviderSpendList providers={providers ?? []} window={window_} />}
    </section>
  );
}

function providersEmpty(providers: ProviderUsage[] | null): boolean {
  return providers !== null && providers.every((row) => providerSpend(row) <= 0);
}

function providerSpend(row: ProviderUsage): number {
  return row.cost_usd + row.estimated_cost_usd;
}

/** Provider names come from the gateway ledger; label the known ones nicely. */
function providerLabel(provider: string | null): string {
  if (provider === null) {
    return "(undispatched)";
  }
  return (MODEL_PROVIDERS as readonly string[]).includes(provider)
    ? modelProviderLabel(provider as ModelProvider)
    : provider;
}

function HeadlineStat({
  label,
  value,
  detail,
  warn = false
}: {
  label: string;
  value: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-2">
        {label}
      </span>
      <span className={warn ? "text-[17px] font-semibold text-warning" : "text-[17px] font-semibold text-ink"}>
        {value}
      </span>
      {detail !== undefined && <span className="text-[11px] text-muted">{detail}</span>}
    </span>
  );
}

/**
 * Spend per provider in the picked window, biggest first, each with a share
 * bar off the leader. Providers with no dollars this window stay out; an all
 * quiet window says so instead of listing zeros.
 */
function ProviderSpendList({
  providers,
  window: windowKey
}: {
  providers: ProviderUsage[];
  window: ServingWindow;
}) {
  const rows = providers
    .filter((row) => providerSpend(row) > 0)
    .sort((a, b) => providerSpend(b) - providerSpend(a));
  if (rows.length === 0) {
    return null;
  }
  const peak = providerSpend(rows[0]);
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3" data-testid="spend-by-provider">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-2">
        By provider · {windowKey}
      </span>
      {rows.map((row) => (
        <div
          className="flex items-center gap-3 text-[13px]"
          data-testid={`spend-provider-${row.provider ?? "undispatched"}`}
          key={row.provider ?? "undispatched"}
        >
          <span className="w-32 shrink-0 truncate text-ink">{providerLabel(row.provider)}</span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.05]">
            <span
              aria-hidden
              className="block h-full rounded-full bg-foreground/40"
              style={{ width: `${Math.max(2, (providerSpend(row) / peak) * 100)}%` }}
            />
          </span>
          <span className="w-20 shrink-0 text-right font-mono text-ink">
            {formatCostUsd(providerSpend(row))}
          </span>
        </div>
      ))}
    </div>
  );
}
