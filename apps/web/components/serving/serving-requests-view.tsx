"use client";

import { FRONTIER_MODEL_LABEL, formatCostUsd, formatRequestCostUsd } from "@/lib/money";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import { StatTile } from "@/components/ui/StatTile";
import { formatTokensInOut } from "@/components/playground/usage-model";
import { fetchServingRoutingAudit, type ServingRoutingAuditPayload } from "@/lib/serving-audit";
import { SERVING_PAGE_SIZE, SERVING_WINDOWS, formatLatencyMs, servingRequestQueryString, type ServingViewState } from "@/lib/serving-telemetry";
import type {
  ServingRequest,
  ServingRequestCursor,
  ServingRequestDetail,
  ServingSummary
} from "@/lib/types";

import { JsonBlock, TextBlock } from "./payload-blocks";
import { RoutingDecision } from "./routing-decision";
import { ServingActivityChart } from "./serving-activity-chart";

const AUTO_REFRESH_MS = 10_000;

// Counts render on the server and hydrate on arbitrary client locales, so
// formatting must be locale-pinned or the markup mismatches on hydration.
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

type ServingRequestsViewProps = {
  orgId: string;
  initialView: ServingViewState;
  initialSummary: ServingSummary;
  initialRequests: ServingRequest[];
  initialCursor: ServingRequestCursor | null;
  /** Server clock at render time; advances client-side on each reload. */
  nowMs: number;
  /**
   * Whether the viewer operates the platform. Decided server-side; when false
   * the routing section is not rendered and its fetch is never issued, so
   * Telemetry stays routing-opaque even in the network tab.
   */
  canAuditRouting: boolean;
  /**
   * Pin the view to one endpoint; the filter cannot be widened. This view now
   * serves only the Project page's Telemetry tab, so the pin is required —
   * the org-wide surface is the gateway-ledger Telemetry page.
   */
  lockedEndpointId: string;
};

export function ServingRequestsView({
  orgId,
  initialView,
  initialSummary,
  initialRequests,
  initialCursor,
  nowMs,
  canAuditRouting,
  lockedEndpointId
}: ServingRequestsViewProps) {
  const [view, setView] = useState<ServingViewState>({
    ...initialView,
    endpointId: lockedEndpointId
  });
  const [summary, setSummary] = useState<ServingSummary>(initialSummary);
  const [requests, setRequests] = useState<ServingRequest[]>(initialRequests);
  const [cursor, setCursor] = useState<ServingRequestCursor | null>(initialCursor);
  const [chartNowMs, setChartNowMs] = useState(nowMs);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(initialView.live);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ServingRequestDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [audits, setAudits] = useState<Record<string, ServingRoutingAuditPayload>>({});
  const [auditErrors, setAuditErrors] = useState<Record<string, string>>({});

  // One sequence for every list-mutating fetch (reload AND load-more): a
  // stale load-more must not append onto a list a newer reload replaced.
  const requestSeq = useRef(0);
  // Per-row fetches already in flight, keyed `<kind>:<id>`. The result maps are
  // only written on resolve, so collapsing and reopening a row before its
  // response lands would fire the same request again without this.
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(false);

  const load = useCallback(
    async (target: ServingViewState, options?: { quiet?: boolean }) => {
      const seq = ++requestSeq.current;
      if (!options?.quiet) {
        setLoading(true);
      }
      const listQs = servingRequestQueryString({
        endpoint: target.endpointId ?? undefined,
        status: target.errorsOnly ? "error" : undefined,
        window: target.window,
        limit: SERVING_PAGE_SIZE
      });
      const summaryParams = new URLSearchParams({ window: target.window });
      if (target.endpointId) {
        summaryParams.set("endpoint", target.endpointId);
      }
      try {
        const [summaryResponse, listResponse] = await Promise.all([
          fetch(`/api/orgs/${orgId}/serving/summary?${summaryParams}`, { cache: "no-store" }),
          fetch(`/api/orgs/${orgId}/serving/requests?${listQs}`, { cache: "no-store" })
        ]);
        if (!summaryResponse.ok || !listResponse.ok) {
          throw new Error(
            `Failed to load serving telemetry (${summaryResponse.ok ? listResponse.status : summaryResponse.status})`
          );
        }
        const nextSummary = (await summaryResponse.json()) as ServingSummary;
        const page = (await listResponse.json()) as {
          requests: ServingRequest[];
          next_cursor: ServingRequestCursor | null;
        };
        if (requestSeq.current === seq) {
          setSummary(nextSummary);
          setRequests(page.requests);
          setCursor(page.next_cursor);
          setChartNowMs(Date.now());
          setError(null);
        }
      } catch (loadError) {
        if (requestSeq.current === seq) {
          setError(
            loadError instanceof Error ? loadError.message : "Failed to load serving telemetry"
          );
        }
      } finally {
        if (requestSeq.current === seq) {
          setLoading(false);
        }
      }
    },
    [orgId]
  );

  // Refetch on filter/window changes; the server page delivered the first set.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void load(view);
  }, [load, view]);

  const paginated = requests.length > SERVING_PAGE_SIZE;

  // Auto-refresh replaces the list with a fresh first page, so it pauses
  // while the user is deep in older pages instead of yanking them back.
  useEffect(() => {
    if (!autoRefresh || paginated) {
      return;
    }
    const timer = setInterval(() => {
      void load(view, { quiet: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load, paginated, view]);

  const loadMore = async () => {
    if (!cursor) {
      return;
    }
    const seq = requestSeq.current;
    setLoadingMore(true);
    const qs = servingRequestQueryString({
      endpoint: view.endpointId ?? undefined,
      status: view.errorsOnly ? "error" : undefined,
      window: view.window,
      cursor,
      limit: SERVING_PAGE_SIZE
    });
    try {
      const response = await fetch(`/api/orgs/${orgId}/serving/requests?${qs}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Failed to load more requests (${response.status})`);
      }
      const page = (await response.json()) as {
        requests: ServingRequest[];
        next_cursor: ServingRequestCursor | null;
      };
      // A reload (filter change, refresh tick) invalidates this page.
      if (requestSeq.current === seq) {
        setRequests((current) => [...current, ...page.requests]);
        setCursor(page.next_cursor);
      }
    } catch (moreError) {
      if (requestSeq.current === seq) {
        setError(
          moreError instanceof Error ? moreError.message : "Failed to load more requests"
        );
      }
    } finally {
      setLoadingMore(false);
    }
  };

  // The operator read is a second, separately gated request: the Telemetry
  // detail route deliberately serves no routing fields, so there is nothing to
  // widen and no shared payload the two audiences could read differently.
  const loadAudit = async (requestId: string) => {
    const key = `audit:${requestId}`;
    if (!canAuditRouting || audits[requestId] || inFlight.current.has(key)) {
      return;
    }
    inFlight.current.add(key);
    try {
      const payload = await fetchServingRoutingAudit(requestId);
      setAudits((current) => ({ ...current, [requestId]: payload }));
      setAuditErrors((current) => {
        const { [requestId]: _, ...rest } = current;
        return rest;
      });
    } catch (auditError) {
      setAuditErrors((current) => ({
        ...current,
        [requestId]:
          auditError instanceof Error ? auditError.message : "Failed to load the routing decision"
      }));
    } finally {
      inFlight.current.delete(key);
    }
  };

  const toggleExpanded = async (requestId: string) => {
    if (expandedId === requestId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(requestId);
    void loadAudit(requestId);
    const detailKey = `detail:${requestId}`;
    if (details[requestId] || inFlight.current.has(detailKey)) {
      return;
    }
    inFlight.current.add(detailKey);
    try {
      const response = await fetch(`/api/orgs/${orgId}/serving/requests/${requestId}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Failed to load request (${response.status})`);
      }
      const payload = (await response.json()) as { request: ServingRequestDetail };
      setDetails((current) => ({ ...current, [requestId]: payload.request }));
      setDetailErrors((current) => {
        const { [requestId]: _, ...rest } = current;
        return rest;
      });
    } catch (fetchError) {
      setDetailErrors((current) => ({
        ...current,
        [requestId]:
          fetchError instanceof Error ? fetchError.message : "Failed to load request"
      }));
    } finally {
      inFlight.current.delete(detailKey);
    }
  };

  const stats = summary.stats;
  const errorRate =
    stats.request_count > 0 ? (stats.error_count / stats.request_count) * 100 : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="shrink-0 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="inline-flex rounded-[var(--radius-md)] border border-line p-[2px]">
            {SERVING_WINDOWS.map((entry) => (
              <button
                className={clsx(
                  "cursor-pointer rounded-[4px] px-2.5 py-1 text-[12px] font-medium",
                  view.window === entry.key
                    ? "bg-ink text-white"
                    : "bg-transparent text-muted hover:text-[#474747]"
                )}
                key={entry.key}
                onClick={() => setView((current) => ({ ...current, window: entry.key }))}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3">
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
              <RotateCw aria-hidden className={clsx(loading && "animate-spin")} size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Requests" value={COUNT_FORMAT.format(stats.request_count)} />
          <button
            aria-pressed={view.errorsOnly}
            className={clsx(
              "cursor-pointer rounded-[var(--radius-md)] border p-0 text-left",
              stats.error_count > 0 ? "border-danger bg-danger-soft" : "border-line bg-surface",
              view.errorsOnly && "ring-1 ring-danger"
            )}
            onClick={() => setView((current) => ({ ...current, errorsOnly: !current.errorsOnly }))}
            title="Toggle errors-only"
            type="button"
          >
            <StatTile
              bare
              label="Errors"
              tone={stats.error_count > 0 ? "danger" : undefined}
              value={`${COUNT_FORMAT.format(stats.error_count)} · ${errorRate.toFixed(1)}%`}
            />
          </button>
          <StatTile
            label="Latency p50 / p95"
            value={`${formatLatencyMs(stats.latency_p50_ms)} / ${formatLatencyMs(stats.latency_p95_ms)}`}
          />
          <StatTile
            label="Spend this window"
            value={
              stats.unpriced_count > 0
                ? `${formatCostUsd(stats.cost_usd_total)} · ${COUNT_FORMAT.format(stats.unpriced_count)} unpriced`
                : formatCostUsd(stats.cost_usd_total)
            }
          />
        </div>
        <div className="mt-3">
          <ServingActivityChart
            bucketSeconds={summary.bucket_seconds}
            buckets={summary.buckets}
            nowMs={chartNowMs}
            window={summary.window}
          />
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
        <header className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
            <input
              checked={view.errorsOnly}
              onChange={(event) =>
                setView((current) => ({ ...current, errorsOnly: event.target.checked }))
              }
              type="checkbox"
            />
            Errors only
          </label>
          <span className="ml-auto text-[11px] text-muted-2">
            {COUNT_FORMAT.format(requests.length)} shown
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <p className="m-0 border-b border-danger bg-danger-soft px-3.5 py-2 text-[12px] text-danger">
              {error}
            </p>
          )}
          {loading && requests.length === 0 ? (
            <div className="flex flex-col gap-2 p-3.5">
              <Shimmer className="h-[36px] rounded-md" />
              <Shimmer className="h-[36px] rounded-md" />
              <Shimmer className="h-[36px] rounded-md" />
            </div>
          ) : requests.length === 0 ? (
            !error && (
              <p className="m-0 px-3.5 py-3 text-[12px] text-muted">
                No requests match the current window and filters.
              </p>
            )
          ) : (
            <table className={clsx("w-full border-collapse text-[12px]", loading && "opacity-60")}>
              <thead>
                <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted-2">
                  <th className="w-6 px-2 py-2" />
                  <th className="px-2 py-2 font-semibold">Time</th>
                  <th className="px-2 py-2 font-semibold">Endpoint</th>
                  <th className="px-2 py-2 text-right font-semibold">Tokens in/out</th>
                  <th className="px-2 py-2 text-right font-semibold">Cost</th>
                  <th className="px-2 py-2 text-right font-semibold" title={`The same tokens priced at ${FRONTIER_MODEL_LABEL} list price`}>
                    At frontier list
                  </th>
                  <th className="px-2 py-2 text-right font-semibold">Latency</th>
                  <th className="px-2 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <ExpandableRow
                    audit={audits[request.id]}
                    auditError={auditErrors[request.id] ?? null}
                    canAuditRouting={canAuditRouting}
                    detail={details[request.id]}
                    detailError={detailErrors[request.id] ?? null}
                    expanded={expandedId === request.id}
                    key={request.id}
                    onToggle={() => void toggleExpanded(request.id)}
                    request={request}
                  />
                ))}
              </tbody>
            </table>
          )}
          {cursor && (
            <div className="border-t border-line p-2.5 text-center">
              <button
                className="cursor-pointer rounded bg-transparent px-2 py-1 text-[12px] font-medium text-muted hover:text-ink disabled:cursor-default disabled:opacity-50"
                disabled={loadingMore || loading}
                onClick={() => void loadMore()}
                type="button"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ExpandableRow({
  request,
  expanded,
  detail,
  detailError,
  audit,
  auditError,
  canAuditRouting,
  onToggle
}: {
  request: ServingRequest;
  expanded: boolean;
  detail: ServingRequestDetail | undefined;
  detailError: string | null;
  audit: ServingRoutingAuditPayload | undefined;
  auditError: string | null;
  canAuditRouting: boolean;
  onToggle: () => void;
}) {
  const isError = request.status === "error";
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        className={clsx(
          "cursor-pointer border-b border-line hover:bg-foreground/[0.03]",
          expanded && "bg-foreground/[0.03]"
        )}
        onClick={onToggle}
      >
        <td className="px-1 py-1">
          {/* The row-level onClick is a pointer convenience; this button is
              the keyboard/AT path to the same toggle. */}
          <button
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse request" : "Expand request"}
            className="cursor-pointer rounded bg-transparent p-1 text-muted-2 hover:text-ink"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            type="button"
          >
            <Chevron aria-hidden size={12} strokeWidth={2} />
          </button>
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-muted">
          <LocalDateTime value={request.created_at} />
        </td>
        <td className="max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2 font-medium text-ink">
          {request.endpoint_label}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted">
          {formatTokensInOut(request.input_tokens, request.output_tokens)}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-ink">
          {formatRequestCostUsd(request.cost_usd)}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-2">
          {formatRequestCostUsd(request.frontier_cost_usd)}
        </td>
        <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
          {formatLatencyMs(request.latency_ms)}
        </td>
        <td className="px-2 py-2">
          {isError ? (
            <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">
              Error
            </span>
          ) : (
            <span className="text-[11px] text-muted-2">OK</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-line bg-surface-subtle/40">
          <td className="px-3.5 py-3" colSpan={8}>
            {isError && request.error_message && (
              <TextBlock isError label="Error" text={request.error_message} />
            )}
            {canAuditRouting && <RoutingDecision audit={audit} error={auditError} />}
            {detailError ? (
              <p className="m-0 text-[12px] text-danger">{detailError}</p>
            ) : detail === undefined ? (
              <Shimmer className="mt-2 h-[72px] rounded-md" />
            ) : (
              <>
                {detail.ttfb_ms !== null && (
                  <p className="m-0 text-[11px] text-muted-2">
                    First byte after {formatLatencyMs(detail.ttfb_ms)}
                    {detail.cached_tokens > 0 &&
                      ` · ${COUNT_FORMAT.format(detail.cached_tokens)} cached tokens`}
                  </p>
                )}
                {detail.request !== null ? (
                  <JsonBlock label="Request" value={detail.request} />
                ) : (
                  <p className="m-0 mt-2 text-[12px] text-muted">No request body stored.</p>
                )}
                {detail.response !== null ? (
                  <JsonBlock label="Response" value={detail.response} />
                ) : (
                  <p className="m-0 mt-2 text-[12px] text-muted">No response body stored.</p>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
