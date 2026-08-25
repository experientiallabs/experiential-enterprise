"use client";

import { useState } from "react";

import { clsx } from "clsx";

import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { agentLabel, displayModel, laneLabel, topToolsUsed } from "@/lib/gateway-telemetry";
import { gatewayRequestOutcomeReason, gatewayRequestStatusLabel } from "@/lib/format";
import { formatThroughput, providerLabel } from "@/lib/models-catalog/format";
import { formatRequestCostUsd } from "@/lib/money";
import { formatLatencyMs } from "@/lib/serving-telemetry";
import type { CapturedPrompt, UsageRequestItem } from "@/lib/types";

// Locale-pinned so server render and hydration agree.
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

// Most-used tools to name in the summary strip; the rest fold into a +N chip.
const MAX_SUMMARY_TOOLS = 8;

type RequestsSectionProps = {
  orgId: string;
  requests: UsageRequestItem[];
  errorsOnly: boolean;
  onToggleErrorsOnly: (next: boolean) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  loading: boolean;
  error: string | null;
};

/**
 * The per-call gateway log. The ledger is content-free — bodies are never
 * persisted — so each row is the complete tenant-visible record. The one
 * opt-in exception: orgs with prompt capture on can expand a row's Prompt
 * chip to read the captured prompt (fetched on demand, 404 = not captured).
 */
export function RequestsSection({
  orgId,
  requests,
  errorsOnly,
  onToggleErrorsOnly,
  hasMore,
  loadingMore,
  onLoadMore,
  loading,
  error
}: RequestsSectionProps) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        <h2 className="m-0 text-[13px] font-semibold text-ink">Request history</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
          <input
            checked={errorsOnly}
            onChange={(event) => onToggleErrorsOnly(event.target.checked)}
            type="checkbox"
          />
          Errors only
        </label>
        <span className="ml-auto text-[11px] text-muted-2">
          {COUNT_FORMAT.format(requests.length)} shown
        </span>
      </header>
      {error && (
        <p className="m-0 border-b border-danger bg-danger-soft px-3.5 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {requests.length > 0 && <ToolsCalledSummary requests={requests} />}
      <div className="min-h-0 flex-1 overflow-auto">
        {requests.length === 0 ? (
          !error && (
            <p className="m-0 px-3.5 py-3 text-[12px] text-muted">
              No requests match the current window and filters.
            </p>
          )
        ) : (
          <table className={clsx("w-full border-collapse text-[12px]", loading && "opacity-60")}>
            <thead className="sticky top-0 z-[1] bg-surface">
              <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted-2">
                <th className="bg-surface px-2 py-2 font-semibold">Time</th>
                <th className="bg-surface px-2 py-2 font-semibold">Model</th>
                <th className="bg-surface px-2 py-2 font-semibold">Provider</th>
                <th className="bg-surface px-2 py-2 font-semibold">API key</th>
                <th className="bg-surface px-2 py-2 font-semibold">Prompt</th>
                <th className="bg-surface px-2 py-2 font-semibold">Usage type</th>
                <th className="bg-surface px-2 py-2 text-right font-semibold">Input</th>
                <th className="bg-surface px-2 py-2 text-right font-semibold">Output</th>
                <th className="bg-surface px-2 py-2 font-semibold">Tools</th>
                <th className="bg-surface px-2 py-2 text-right font-semibold">Cost</th>
                <th className="bg-surface px-2 py-2 text-right font-semibold">Speed</th>
                <th className="bg-surface px-2 py-2 text-right font-semibold">TTFT</th>
                <th className="bg-surface px-2 py-2 text-right font-semibold">Latency</th>
                <th className="bg-surface px-2 py-2 font-semibold">Finish reason</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <RequestRow key={request.request_id} orgId={orgId} request={request} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {hasMore && (
        <div className="shrink-0 border-t border-line p-2.5 text-center">
          <button
            className="cursor-pointer rounded bg-transparent px-2 py-1 text-[12px] font-medium text-muted hover:text-ink disabled:cursor-default disabled:opacity-50"
            disabled={loadingMore || loading}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The tools invoked across the loaded requests, most-used first. Renders the
 * honest empty state when nothing captured a tool call — the current state
 * everywhere, since the WMO runtime does not yet surface tool names.
 */
function ToolsCalledSummary({ requests }: { requests: UsageRequestItem[] }) {
  const allTools = topToolsUsed(requests, Number.MAX_SAFE_INTEGER);
  const shown = allTools.slice(0, MAX_SUMMARY_TOOLS);
  const hidden = allTools.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-2">
        Tools called
      </span>
      {shown.length === 0 ? (
        <span className="text-[12px] text-muted">No tool calls recorded yet</span>
      ) : (
        <>
          {shown.map((tool) => (
            <ToolChip key={tool.name} label={tool.name} count={tool.count} />
          ))}
          {hidden > 0 && <span className="text-[11px] text-muted-2">+{hidden} more</span>}
        </>
      )}
    </div>
  );
}

/** A neutral names-only tool pill; an optional count trails it in the summary. */
function ToolChip({ label, count }: { label: string; count?: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">
      <span className="max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      {count !== undefined && <span className="tabular-nums text-muted-2">{count}</span>}
    </span>
  );
}

/** The full non-content token breakdown for a row's tooltip. */
function tokenBreakdown(request: UsageRequestItem): string {
  const parts = [
    `${COUNT_FORMAT.format(request.input_tokens)} prompt`,
    `${COUNT_FORMAT.format(request.output_tokens)} completion`
  ];
  if (request.cached_input_tokens > 0) {
    parts.push(`${COUNT_FORMAT.format(request.cached_input_tokens)} cached`);
  }
  if (request.reasoning_tokens > 0) {
    parts.push(`${COUNT_FORMAT.format(request.reasoning_tokens)} reasoning`);
  }
  return parts.join(" · ");
}

/**
 * The per-call cost cell. It leads with the ALWAYS-REAL cost (charged credits
 * plus the never-charged BYOK estimate) so a BYOK call never reads as free, and
 * says "unpriced" — never "$0.00" — when the serving route had no known price.
 * The tooltip keeps the billed-vs-estimated split so an estimate is never
 * mistaken for billed money.
 */
function CostCell({ request }: { request: UsageRequestItem }) {
  if (!request.pricing_known) {
    return (
      <span
        className="text-muted-2"
        title="No price was available for the route that served this request, so its cost could not be computed."
      >
        unpriced
      </span>
    );
  }
  const estimateOnly = request.estimated_cost_usd > 0 && request.cost_usd === 0;
  const title =
    request.estimated_cost_usd > 0
      ? `Real cost ${formatRequestCostUsd(request.real_cost_usd)}, ${formatRequestCostUsd(request.cost_usd)} billed to credits, ${formatRequestCostUsd(request.estimated_cost_usd)} estimated on your own provider key (never charged).`
      : `Real cost ${formatRequestCostUsd(request.real_cost_usd)}, billed to platform credits.`;
  return (
    <span className={estimateOnly ? "text-muted" : "text-ink"} title={title}>
      {formatRequestCostUsd(request.real_cost_usd)}
      {estimateOnly && <span className="text-[10px] text-muted-2"> est.</span>}
    </span>
  );
}

/**
 * Output throughput in tokens/second: completion tokens over the request's
 * wall-clock latency. Null (renders as a dash) when either side is missing, so
 * a $0-token or unlatenced row never shows a fabricated speed.
 */
function outputTokensPerSecond(request: UsageRequestItem): number | null {
  if (request.latency_ms === null || request.latency_ms <= 0 || request.output_tokens <= 0) {
    return null;
  }
  return request.output_tokens / (request.latency_ms / 1000);
}

function RequestRow({ orgId, request }: { orgId: string; request: UsageRequestItem }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState<CapturedPrompt | null>(null);
  const [promptState, setPromptState] = useState<"idle" | "loading" | "missing" | "error">(
    "idle"
  );

  async function togglePrompt() {
    if (promptOpen) {
      setPromptOpen(false);
      return;
    }
    setPromptOpen(true);
    if (prompt !== null || promptState === "missing") {
      return;
    }
    setPromptState("loading");
    try {
      const response = await fetch(
        `/api/orgs/${orgId}/usage/requests/${encodeURIComponent(request.request_id)}/prompt`,
        { cache: "no-store" }
      );
      if (response.status === 404) {
        setPromptState("missing");
        return;
      }
      if (!response.ok) {
        throw new Error(`prompt fetch failed (${response.status})`);
      }
      setPrompt((await response.json()) as CapturedPrompt);
      setPromptState("idle");
    } catch {
      setPromptState("error");
    }
  }

  const isError = request.status !== "completed";
  const reason = gatewayRequestOutcomeReason(request.status, request.error_message);
  const dispatchNote = `${request.attempt_count} provider dispatch${request.attempt_count === 1 ? "" : "es"}`;
  const statusTitle = reason === null ? dispatchNote : `${reason} (${dispatchNote})`;
  return (
    <>
    <tr className="border-b border-line">
      <td className="whitespace-nowrap px-2 py-2 text-muted">
        <LocalDateTime value={request.created_at} />
      </td>
      <td className="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2 font-medium text-ink">
        {displayModel(request.model)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-muted">
        {request.provider === null ? (
          <span className="text-muted-2">—</span>
        ) : (
          providerLabel(request.provider)
        )}
      </td>
      <td className="max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2 text-muted">
        {agentLabel(request.api_key_id, request.key_label)}
      </td>
      <td className="whitespace-nowrap px-2 py-2">
        {/* Content-free lineage handles: same prompt group = same system
            prompt + tools; the title carries the conversation thread. */}
        {request.prompt_group === null ? (
          <span className="text-muted-2">—</span>
        ) : (
          <button
            className="cursor-pointer rounded border-0 bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-muted hover:text-ink"
            onClick={() => void togglePrompt()}
            title={
              request.conversation_group === null
                ? `Prompt group ${request.prompt_group}, click to view the captured prompt`
                : `Prompt group ${request.prompt_group} · conversation ${request.conversation_group}, click to view the captured prompt`
            }
            type="button"
          >
            {request.prompt_group.slice(0, 8)}
          </button>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-muted">{laneLabel(request.lane)}</td>
      <td
        className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted"
        title={tokenBreakdown(request)}
      >
        {COUNT_FORMAT.format(request.input_tokens)}
        {request.cached_input_tokens > 0 && (
          <span className="text-[10px] text-muted-2"> ({COUNT_FORMAT.format(request.cached_input_tokens)} cached)</span>
        )}
      </td>
      <td
        className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted"
        title={tokenBreakdown(request)}
      >
        {COUNT_FORMAT.format(request.output_tokens)}
        {request.reasoning_tokens > 0 && (
          <span className="text-[10px] text-muted-2">
            {" "}
            +{COUNT_FORMAT.format(request.reasoning_tokens)}r
          </span>
        )}
      </td>
      <td className="max-w-[220px] px-2 py-2">
        {request.tools_used.length === 0 ? (
          <span className="text-muted-2">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {request.tools_used.map((tool) => (
              <ToolChip key={tool} label={tool} />
            ))}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
        <CostCell request={request} />
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
        {formatThroughput(outputTokensPerSecond(request))}
      </td>
      <td
        className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted"
        title="Time to first token: provider dispatch to the first streamed token on the winning attempt. Empty when no first token was observed (e.g. failed before streaming, or served before TTFT capture shipped)."
      >
        {formatLatencyMs(request.ttft_ms)}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
        {formatLatencyMs(request.latency_ms)}
      </td>
      <td className="max-w-[220px] px-2 py-2">
        {isError ? (
          <span className="flex flex-col gap-0.5">
            <span
              className="w-fit rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger"
              title={statusTitle}
            >
              {gatewayRequestStatusLabel(request.status)}
            </span>
            {reason !== null && (
              <span className="text-[10px] leading-snug text-muted-2" title={reason}>
                {reason}
              </span>
            )}
          </span>
        ) : (
          <span className="text-[11px] text-muted-2" title={statusTitle}>
            OK
          </span>
        )}
      </td>
    </tr>
    {promptOpen && (
      <tr className="border-b border-line bg-surface-subtle">
        <td className="px-3 py-2" colSpan={14}>
          {promptState === "loading" && (
            <span className="text-[11px] text-muted-2">Loading captured prompt…</span>
          )}
          {promptState === "missing" && (
            <span className="text-[11px] text-muted-2">
              No captured prompt for this request, capture was off when it ran, or the
              30-day retention expired it.
            </span>
          )}
          {promptState === "error" && (
            <span className="text-[11px] text-danger">The captured prompt could not load.</span>
          )}
          {prompt !== null && (
            <div className="flex max-h-[300px] flex-col gap-1.5 overflow-y-auto">
              {prompt.messages.map((message, index) => (
                <div className="flex flex-col" key={`${request.request_id}-m${index}`}>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-2">
                    {message.role}
                  </span>
                  <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">
                    {message.content ?? "(no text content)"}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </td>
      </tr>
    )}
    </>
  );
}
