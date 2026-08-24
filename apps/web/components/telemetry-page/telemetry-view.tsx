"use client";

import { clsx } from "clsx";
import { RotateCw } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { buttonClassName } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import { StatTile } from "@/components/ui/StatTile";
import {
  agentLabel,
  allSpendUsd,
  displayModel,
  laneSpendSeries,
  latencyPercentiles,
  modelOptions,
  modelRollups,
  modelSpendSeries,
  telemetryViewQueryString,
  usageRequestsQueryFromView,
  usageRequestsQueryString,
  usageTimeseriesQueryString,
  usageTotals,
  USAGE_PAGE_SIZE,
  type TelemetryViewState
} from "@/lib/gateway-telemetry";
import { formatTokens } from "@/lib/format";
import { formatCostUsd } from "@/lib/money";
import { SERVING_WINDOWS, formatLatencyMs } from "@/lib/serving-telemetry";
import { demoByKey, demoByProvider, demoRequests, demoTimeseries } from "@/lib/telemetry-demo";
import type {
  ImportedUsage,
  ServingWindow,
  UsageByKey,
  UsageByProvider,
  UsageLane,
  UsageRequestItem,
  UsageRequestsCursor,
  UsageTimeseries
} from "@/lib/types";

import { FirstCallSection } from "./first-call";
import { ImportedSpendSection } from "./imported-spend";
import { RequestsSection } from "./requests-table";
import { SpendChart } from "./spend-chart";
import { UsageBreakdownCard } from "./usage-tables";

const AUTO_REFRESH_MS = 10_000;
const EMPTY_STATE_POLL_MS = 30_000;

// Locale-pinned so server render and hydration agree.
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

type TelemetryViewProps = {
  orgId: string;
  initialView: TelemetryViewState;
  initialTimeseries: UsageTimeseries;
  initialByKey: UsageByKey;
  initialByProvider: UsageByProvider;
  initialRequests: UsageRequestItem[];
  initialCursor: UsageRequestsCursor | null;
  /** Server clock at render time; advances client-side on each reload. */
  nowMs: number;
  /** The never-used state's copyable first call; null offers the create door. */
  firstCall: { modelName: string; baseUrl: string } | null;
  /**
   * Imported historical spend (Codex / Claude Code), attribution-only. Absent
   * in the signed-out demo; the section renders only when there is data.
   */
  initialImported?: ImportedUsage;
  /**
   * Signed-out affordance rendered as a slim strip above the filter bar (the
   * "Demo data" chip + login CTA); absent for signed-in members.
   */
  banner?: ReactNode;
  /**
   * Signed-out mode: every reload resolves from the deterministic demo
   * dataset in lib/telemetry-demo.ts instead of fetching, through the exact
   * same components and view state — no forked UI.
   */
  demo?: boolean;
};

/**
 * The Telemetry page body: one filter bar (window, model, agent, lane) driving
 * a single-viewport layout — a stat strip, the spend chart, the Usage
 * breakdown (by model / by agent), and the request history — over the gateway
 * usage ledger. The page fills the viewport and never scrolls; the Usage and
 * request-history cards scroll internally instead. The view state is the URL,
 * so a filtered view pastes into a teammate's browser, auto-refresh included.
 */
export function TelemetryView({
  orgId,
  initialView,
  initialTimeseries,
  initialByKey,
  initialByProvider,
  initialRequests,
  initialCursor,
  nowMs,
  firstCall,
  initialImported,
  banner,
  demo = false
}: TelemetryViewProps) {
  const pathname = usePathname();
  const loginModal = useLoginModal();
  const [view, setView] = useState<TelemetryViewState>(initialView);
  const [timeseries, setTimeseries] = useState<UsageTimeseries>(initialTimeseries);
  const [byKey, setByKey] = useState<UsageByKey>(initialByKey);
  const [byProvider, setByProvider] = useState<UsageByProvider>(initialByProvider);
  const [requests, setRequests] = useState<UsageRequestItem[]>(initialRequests);
  const [cursor, setCursor] = useState<UsageRequestsCursor | null>(initialCursor);
  const [chartNowMs, setChartNowMs] = useState(nowMs);
  const [chartMode, setChartMode] = useState<"lane" | "model">("lane");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(initialView.live);

  // One sequence for every list-mutating fetch (reload AND load-more): a
  // stale load-more must not append onto a list a newer reload replaced.
  const requestSeq = useRef(0);
  const mounted = useRef(false);

  // The view state is the URL: filters survive refresh and paste into a
  // teammate's browser. Native replaceState keeps this shallow instead of
  // re-rendering the server page.
  useEffect(() => {
    const qs = telemetryViewQueryString({ ...view, live: autoRefresh });
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // A skipped URL sync beats an error screen.
    }
  }, [autoRefresh, pathname, view]);

  const load = useCallback(
    async (target: TelemetryViewState, options?: { quiet?: boolean }) => {
      const seq = ++requestSeq.current;
      if (demo) {
        // Signed-out: resolve every "fetch" from the deterministic demo
        // dataset so filters, windows, and refresh behave exactly like the
        // real page — the demo IS the sales demo.
        const at = Date.now();
        const timeseriesQuery = {
          window: target.window,
          model: target.model ?? undefined,
          apiKeyId: target.agentId ?? undefined,
          lane: target.lane ?? undefined
        };
        const page = demoRequests(usageRequestsQueryFromView(target), at);
        setTimeseries(demoTimeseries(timeseriesQuery, at));
        setByKey(demoByKey(target.window, at));
        setByProvider(demoByProvider(target.window, at));
        setRequests(page.requests);
        setCursor(page.next_cursor);
        setChartNowMs(at);
        setError(null);
        return;
      }
      if (!options?.quiet) {
        setLoading(true);
      }
      const timeseriesQs = usageTimeseriesQueryString({
        window: target.window,
        model: target.model ?? undefined,
        apiKeyId: target.agentId ?? undefined,
        lane: target.lane ?? undefined
      });
      const requestsQs = usageRequestsQueryString(usageRequestsQueryFromView(target));
      try {
        const [timeseriesResponse, byKeyResponse, byProviderResponse, requestsResponse] =
          await Promise.all([
            fetch(`/api/orgs/${orgId}/usage/timeseries?${timeseriesQs}`, { cache: "no-store" }),
            fetch(`/api/orgs/${orgId}/usage/by-key?window=${target.window}`, { cache: "no-store" }),
            fetch(`/api/orgs/${orgId}/usage/by-provider?window=${target.window}`, {
              cache: "no-store"
            }),
            fetch(`/api/orgs/${orgId}/usage/requests?${requestsQs}`, { cache: "no-store" })
          ]);
        const responses = [timeseriesResponse, byKeyResponse, byProviderResponse, requestsResponse];
        if (responses.some((response) => response.status === 401)) {
          // The session expired mid-page; polling stops and the banner takes over.
          if (requestSeq.current === seq) {
            setAuthExpired(true);
            setAutoRefresh(false);
          }
          return;
        }
        const failed = responses.find((response) => !response.ok);
        if (failed) {
          throw new Error(`Failed to load usage (${failed.status})`);
        }
        const nextTimeseries = (await timeseriesResponse.json()) as UsageTimeseries;
        const nextByKey = (await byKeyResponse.json()) as UsageByKey;
        const nextByProvider = (await byProviderResponse.json()) as UsageByProvider;
        const page = (await requestsResponse.json()) as {
          requests: UsageRequestItem[];
          next_cursor: UsageRequestsCursor | null;
        };
        if (requestSeq.current === seq) {
          setTimeseries(nextTimeseries);
          setByKey(nextByKey);
          setByProvider(nextByProvider);
          setRequests(page.requests);
          setCursor(page.next_cursor);
          setChartNowMs(Date.now());
          setError(null);
        }
      } catch (loadError) {
        if (requestSeq.current === seq) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load usage");
        }
      } finally {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      }
    },
    [demo, orgId]
  );

  // Refetch on filter/window changes; the server page delivered the first set.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void load(view);
  }, [load, view]);

  const paginated = requests.length > USAGE_PAGE_SIZE;

  // Auto-refresh replaces the list with a fresh first page, so it pauses
  // while the user is deep in older pages instead of yanking them back.
  useEffect(() => {
    if (!autoRefresh || paginated || authExpired) {
      return;
    }
    const timer = setInterval(() => {
      void load(view, { quiet: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [authExpired, autoRefresh, load, paginated, view]);

  const totals = useMemo(() => usageTotals(timeseries.buckets), [timeseries]);
  const rollups = useMemo(() => modelRollups(timeseries.buckets), [timeseries]);
  const neverUsed =
    totals.requestCount === 0 &&
    requests.length === 0 &&
    byKey.keys.length === 0 &&
    view.model === null &&
    view.agentId === null &&
    view.lane === null &&
    !view.errorsOnly;

  // The never-used state has no controls, so poll gently: the org's first
  // request flips the screen to live data without a reload.
  useEffect(() => {
    if (!neverUsed || authExpired) {
      return;
    }
    const timer = setInterval(() => {
      void load(view, { quiet: true });
    }, EMPTY_STATE_POLL_MS);
    return () => clearInterval(timer);
  }, [authExpired, load, neverUsed, view]);

  const loadMore = async () => {
    if (!cursor) {
      return;
    }
    const seq = requestSeq.current;
    setLoadingMore(true);
    const qs = usageRequestsQueryString(usageRequestsQueryFromView(view, cursor));
    try {
      const response = await fetch(`/api/orgs/${orgId}/usage/requests?${qs}`, {
        cache: "no-store"
      });
      if (response.status === 401) {
        setAuthExpired(true);
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to load more requests (${response.status})`);
      }
      const page = (await response.json()) as {
        requests: UsageRequestItem[];
        next_cursor: UsageRequestsCursor | null;
      };
      // A reload (filter change, refresh tick) invalidates this page.
      if (requestSeq.current === seq) {
        setRequests((current) => [...current, ...page.requests]);
        setCursor(page.next_cursor);
      }
    } catch (moreError) {
      if (requestSeq.current === seq) {
        setError(moreError instanceof Error ? moreError.message : "Failed to load more requests");
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const chartData = useMemo(
    () =>
      chartMode === "lane"
        ? laneSpendSeries(timeseries.buckets, timeseries.bucket_seconds, view.window, chartNowMs)
        : modelSpendSeries(timeseries.buckets, timeseries.bucket_seconds, view.window, chartNowMs),
    [chartMode, chartNowMs, timeseries, view.window]
  );
  const latency = useMemo(() => latencyPercentiles(requests), [requests]);
  const models = useMemo(() => {
    const options = modelOptions(timeseries.buckets, byKey.keys);
    if (view.model !== null && !options.includes(view.model)) {
      options.push(view.model);
    }
    return options;
  }, [byKey, timeseries, view.model]);
  const agents = useMemo(() => {
    const options = byKey.keys
      .filter((key): key is typeof key & { api_key_id: string } => key.api_key_id !== null)
      .map((key) => ({ id: key.api_key_id, label: agentLabel(key.api_key_id, key.key_label) }));
    if (view.agentId !== null && !options.some((option) => option.id === view.agentId)) {
      options.push({ id: view.agentId, label: `Unknown agent (${view.agentId.slice(0, 8)})` });
    }
    return options;
  }, [byKey, view.agentId]);

  const errorRate =
    totals.requestCount > 0 ? (totals.errorCount / totals.requestCount) * 100 : 0;

  return (
    <div className="flex min-h-full flex-col gap-3 lg:h-full lg:min-h-0">
      {banner && <div className="flex shrink-0 items-center justify-end">{banner}</div>}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line py-2">
        <SlidingTabs
          activeKey={view.window}
          ariaLabel="Time window"
          onPick={(key) => setView((current) => ({ ...current, window: key as ServingWindow }))}
          tabs={SERVING_WINDOWS.map((entry) => ({ key: entry.key, label: entry.label }))}
        />
        <Dropdown
          aria-label="Filter by model"
          onChange={(event) =>
            setView((current) => ({ ...current, model: event.target.value || null }))
          }
          value={view.model ?? ""}
        >
          <option value="">All models</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {displayModel(model)}
            </option>
          ))}
        </Dropdown>
        <Dropdown
          aria-label="Filter by agent"
          onChange={(event) =>
            setView((current) => ({ ...current, agentId: event.target.value || null }))
          }
          value={view.agentId ?? ""}
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </Dropdown>
        <Dropdown
          aria-label="Filter by lane"
          onChange={(event) =>
            setView((current) => ({
              ...current,
              lane: (event.target.value || null) as UsageLane | null
            }))
          }
          value={view.lane ?? ""}
        >
          <option value="">All lanes</option>
          <option value="platform">Platform</option>
          <option value="byok">BYOK</option>
        </Dropdown>
        <div className="ml-auto flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
            <input
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              type="checkbox"
            />
            Auto-refresh
          </label>
          <button
            aria-label="Refresh"
            className="cursor-pointer rounded bg-transparent p-1 text-muted-2 hover:text-ink"
            onClick={() => void load(view)}
            type="button"
          >
            <RotateCw
              aria-hidden
              className={clsx(loading && "animate-spin")}
              size={13}
              strokeWidth={1.8}
            />
          </button>
        </div>
      </div>

      {authExpired && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-line bg-warning-soft px-3.5 py-2.5">
          <span className="text-[12px] text-warning">
            Your session expired, so live usage stopped updating. Sign in to continue.
          </span>
          <button
            className={buttonClassName("primary", undefined, "sm")}
            onClick={() => loginModal.open()}
            type="button"
          >
            Sign in
          </button>
        </div>
      )}

      {neverUsed ? (
        <div className="min-h-0 flex-1">
          <FirstCallSection firstCall={firstCall} />
        </div>
      ) : (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatTile
              detail={
                totals.estimatedCostUsd > 0
                  ? `of which ${formatCostUsd(totals.estimatedCostUsd)} est. pass-through`
                  : "platform credits"
              }
              label="Spend"
              value={formatCostUsd(allSpendUsd(totals))}
            />
            <StatTile
              detail="input · output"
              label="Tokens"
              value={`${formatTokens(totals.inputTokens)} · ${formatTokens(totals.outputTokens)}`}
            />
            <button
              aria-pressed={view.errorsOnly}
              className={clsx(
                "cursor-pointer rounded-[var(--radius-md)] border p-0 text-left",
                totals.errorCount > 0 ? "border-danger bg-danger-soft" : "border-line bg-surface",
                view.errorsOnly && "ring-1 ring-danger"
              )}
              onClick={() =>
                setView((current) => ({ ...current, errorsOnly: !current.errorsOnly }))
              }
              title="Toggle errors-only in the request log"
              type="button"
            >
              <StatTile
                bare
                detail={`${COUNT_FORMAT.format(totals.errorCount)} errors · ${errorRate.toFixed(1)}%`}
                label="Requests"
                tone={totals.errorCount > 0 ? "danger" : undefined}
                value={COUNT_FORMAT.format(totals.requestCount)}
              />
            </button>
            <StatTile
              detail={
                latency ? `last ${COUNT_FORMAT.format(latency.sample)} requests` : "no timed requests"
              }
              label="Latency p50 / p95"
              value={
                latency ? `${formatLatencyMs(latency.p50)} / ${formatLatencyMs(latency.p95)}` : "—"
              }
            />
          </div>

          <div className="flex flex-1 flex-col gap-3 lg:min-h-0 lg:flex-row lg:overflow-hidden">
            <div className="flex flex-col gap-3 lg:min-h-0 lg:w-[42%] lg:shrink-0">
              <section className="shrink-0 rounded-[var(--radius-lg)] border border-line bg-surface p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="mono-label">Spend over time</span>
                  <SlidingTabs
                    activeKey={chartMode}
                    ariaLabel="Spend chart series"
                    onPick={(key) => setChartMode(key as "lane" | "model")}
                    tabs={[
                      { key: "lane", label: "By lane" },
                      { key: "model", label: "By model" }
                    ]}
                  />
                </div>
                <div className="mt-2">
                  <SpendChart data={chartData} window={view.window} />
                </div>
              </section>

              <UsageBreakdownCard
                keys={byKey.keys}
                onPickAgent={(agentId) => setView((current) => ({ ...current, agentId }))}
                onPickModel={(model) => setView((current) => ({ ...current, model }))}
                providers={byProvider.providers}
                rollups={rollups}
                view={view}
              />
            </div>

            <RequestsSection
              orgId={orgId}
              error={error}
              errorsOnly={view.errorsOnly}
              hasMore={cursor !== null}
              loading={loading}
              loadingMore={loadingMore}
              onLoadMore={() => void loadMore()}
              onToggleErrorsOnly={(next) =>
                setView((current) => ({ ...current, errorsOnly: next }))
              }
              requests={requests}
            />
          </div>

          {initialImported && <ImportedSpendSection imported={initialImported} />}
        </>
      )}
    </div>
  );
}
