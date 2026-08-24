"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { useState } from "react";

import { SERIES_PALETTE } from "@/components/telemetry-page/chart-palette";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { SlidingTabs } from "@/components/ui/SlidingTabs";
import {
  agentLabel,
  allSpendUsd,
  displayModel,
  type ModelRollup,
  type TelemetryViewState
} from "@/lib/gateway-telemetry";
import { formatTokens } from "@/lib/format";
import { modelProviderLabel } from "@/lib/model-providers";
import { formatCostUsd } from "@/lib/money";
import { apiKeysPath } from "@/lib/routes";
import type { KeyModelUsage, KeyUsage, ProviderUsage } from "@/lib/types";

// Counts render on the server and hydrate on arbitrary client locales, so
// formatting must be locale-pinned or the markup mismatches on hydration.
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

// The share bar names this many models individually (matching the spend
// chart's per-model series cap); the tail aggregates into a neutral "Other".
const MAX_SHARE_SEGMENTS = 5;

/**
 * Charged money and the never-charged estimate, side by side. The split must
 * stay visible wherever spend renders, so an estimate can never read as
 * billed money.
 */
function SpendCell({ costUsd, estimatedCostUsd }: { costUsd: number; estimatedCostUsd: number }) {
  if (estimatedCostUsd <= 0) {
    return <span className="tabular-nums text-ink">{formatCostUsd(costUsd)}</span>;
  }
  return (
    <span className="tabular-nums">
      <span className="text-ink">{formatCostUsd(costUsd + estimatedCostUsd)}</span>
      <span className="block text-[10px] text-muted-2">
        {formatCostUsd(estimatedCostUsd)} est. pass-through
      </span>
    </span>
  );
}

type UsageBreakdownCardProps = {
  rollups: ModelRollup[];
  keys: KeyUsage[];
  providers: ProviderUsage[];
  view: TelemetryViewState;
  onPickModel: (model: string | null) => void;
  onPickAgent: (apiKeyId: string | null) => void;
};

/**
 * One card for the usage breakdowns — by model, by agent, and by platform
 * (= provider) — behind a single toggle, so the same window-scoped ledger
 * reads three ways without stacking cards. The body scrolls internally so
 * the page itself never does.
 */
export function UsageBreakdownCard({
  rollups,
  keys,
  providers,
  view,
  onPickModel,
  onPickAgent
}: UsageBreakdownCardProps) {
  const [mode, setMode] = useState<"model" | "agent" | "platform">("model");
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        <h2 className="m-0 text-[13px] font-semibold text-ink">Usage</h2>
        <SlidingTabs
          activeKey={mode}
          ariaLabel="Usage breakdown"
          onPick={(key) => setMode(key as "model" | "agent" | "platform")}
          tabs={[
            { key: "model", label: "By model" },
            { key: "agent", label: "By agent" },
            { key: "platform", label: "By platform" }
          ]}
        />
        <div className="ml-auto text-[11px]">
          {mode === "platform" ? null : mode === "model"
            ? view.model !== null && (
                <button
                  className="cursor-pointer rounded bg-transparent px-1.5 py-0.5 font-medium text-muted hover:text-ink"
                  onClick={() => onPickModel(null)}
                  type="button"
                >
                  Clear model filter
                </button>
              )
            : (
                <Link className="font-medium text-muted hover:text-ink" href={apiKeysPath()}>
                  Manage keys
                </Link>
              )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "model" ? (
          <ModelTable onPickModel={onPickModel} rollups={rollups} view={view} />
        ) : mode === "agent" ? (
          <AgentTable keys={keys} onPickAgent={onPickAgent} view={view} />
        ) : (
          <PlatformTable providers={providers} view={view} />
        )}
      </div>
    </section>
  );
}

type ModelTableProps = {
  rollups: ModelRollup[];
  view: TelemetryViewState;
  onPickModel: (model: string | null) => void;
};

/**
 * Per-model usage over the filtered window: a share bar colored like the
 * spend chart's per-model series, then one row per model. Clicking a row
 * applies (or clears) that model as the global filter.
 */
function ModelTable({ rollups, view, onPickModel }: ModelTableProps) {
  const totalSpend = rollups.reduce((sum, rollup) => sum + allSpendUsd(rollup), 0);
  const totalTokens = rollups.reduce(
    (sum, rollup) => sum + rollup.inputTokens + rollup.outputTokens,
    0
  );
  // Spend share where money exists; token share for all-free windows so the
  // bar never renders 0% everywhere while traffic clearly flowed.
  const bySpend = totalSpend > 0;
  const shareOf = (rollup: ModelRollup): number =>
    bySpend
      ? allSpendUsd(rollup) / totalSpend
      : totalTokens > 0
        ? (rollup.inputTokens + rollup.outputTokens) / totalTokens
        : 0;
  const named = rollups.slice(0, MAX_SHARE_SEGMENTS);
  const otherShare = rollups.slice(MAX_SHARE_SEGMENTS).reduce((sum, r) => sum + shareOf(r), 0);

  if (rollups.length === 0) {
    return (
      <p className="m-0 px-3.5 py-3 text-[12px] text-muted">
        No usage matches the current window and filters.
      </p>
    );
  }
  return (
    <div className="p-3.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-subtle">
        {named.map((rollup, index) => (
          <div
            className="h-full"
            key={rollup.model}
            style={{
              backgroundColor: SERIES_PALETTE[index % SERIES_PALETTE.length],
              width: `${shareOf(rollup) * 100}%`
            }}
            title={`${displayModel(rollup.model)} · ${Math.round(shareOf(rollup) * 100)}%`}
          />
        ))}
        {otherShare > 0 && (
          <div
            className="h-full bg-muted-2"
            style={{ width: `${otherShare * 100}%` }}
            title={`Other · ${Math.round(otherShare * 100)}%`}
          />
        )}
      </div>
      <table className="mt-3 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted-2">
            <th className="px-2 py-2 font-semibold">Model</th>
            <th className="px-2 py-2 text-right font-semibold">Requests</th>
            <th className="px-2 py-2 text-right font-semibold">Error rate</th>
            <th className="px-2 py-2 text-right font-semibold">Tokens in/out</th>
            <th className="px-2 py-2 text-right font-semibold">Spend</th>
          </tr>
        </thead>
        <tbody>
          {rollups.map((rollup, index) => {
            const active = view.model === rollup.model;
            return (
              <tr
                aria-pressed={active}
                className={clsx(
                  "cursor-pointer border-b border-line hover:bg-hover",
                  active && "bg-accent-soft"
                )}
                key={rollup.model}
                onClick={() => onPickModel(active ? null : rollup.model)}
                role="button"
              >
                <td className="whitespace-nowrap px-2 py-2 font-medium text-ink">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                      style={{
                        backgroundColor:
                          index < MAX_SHARE_SEGMENTS
                            ? SERIES_PALETTE[index % SERIES_PALETTE.length]
                            : "var(--muted-2)"
                      }}
                    />
                    {displayModel(rollup.model)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
                  {COUNT_FORMAT.format(rollup.requestCount)}
                </td>
                <td
                  className={clsx(
                    "whitespace-nowrap px-2 py-2 text-right tabular-nums",
                    rollup.errorCount > 0 ? "text-danger" : "text-muted"
                  )}
                >
                  {rollup.requestCount > 0
                    ? `${((rollup.errorCount / rollup.requestCount) * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted">
                  {formatTokens(rollup.inputTokens)} / {formatTokens(rollup.outputTokens)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right">
                  <SpendCell
                    costUsd={rollup.costUsd}
                    estimatedCostUsd={rollup.estimatedCostUsd}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type AgentTableProps = {
  keys: KeyUsage[];
  view: TelemetryViewState;
  onPickAgent: (apiKeyId: string | null) => void;
};

/**
 * One row per organization API key ("an agent = an API key"). The by-key
 * rollup is window-scoped on the backend; the model and agent filters narrow
 * it here from each key's per-model slices. The lane filter has no per-key
 * dimension in the ledger read, so the header says so rather than silently
 * ignoring it.
 */
function AgentTable({ keys, view, onPickAgent }: AgentTableProps) {
  const rows = keys
    .filter((key) => view.agentId === null || key.api_key_id === view.agentId)
    .map((key) => {
      const models =
        view.model === null
          ? key.models
          : key.models.filter((usage) => usage.model === view.model);
      return { key, models, totals: sumModels(models) };
    })
    .filter((row) => row.models.length > 0);

  if (rows.length === 0) {
    return (
      <p className="m-0 px-3.5 py-3 text-[12px] text-muted">
        No agent traffic matches the current window and filters.
      </p>
    );
  }
  return (
    <div className="p-3.5">
      {view.lane !== null && (
        <p className="m-0 mb-2 text-[11px] text-muted-2">
          An agent is an organization API key. Lane filter does not apply here; all lanes shown.
        </p>
      )}
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted-2">
            <th className="px-2 py-2 font-semibold">Agent</th>
            <th className="px-2 py-2 font-semibold">Models</th>
            <th className="px-2 py-2 text-right font-semibold">Requests</th>
            <th className="px-2 py-2 text-right font-semibold">Tokens in/out</th>
            <th className="px-2 py-2 text-right font-semibold">Spend</th>
            <th className="px-2 py-2 text-right font-semibold">Last used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, models, totals }) => {
            // The "(deleted key)" bucket has no id, so it cannot become a
            // filter; it renders as a plain row.
            const filterable = key.api_key_id !== null;
            const active = filterable && view.agentId === key.api_key_id;
            return (
              <tr
                aria-pressed={filterable ? active : undefined}
                className={clsx(
                  "border-b border-line",
                  filterable && "cursor-pointer hover:bg-hover",
                  active && "bg-accent-soft"
                )}
                key={key.api_key_id ?? "(deleted)"}
                onClick={
                  filterable ? () => onPickAgent(active ? null : key.api_key_id) : undefined
                }
                role={filterable ? "button" : undefined}
              >
                <td className="whitespace-nowrap px-2 py-2 font-medium text-ink">
                  {agentLabel(key.api_key_id, key.key_label)}
                </td>
                <td className="max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2 font-mono text-[11px] text-muted">
                  {models.map((usage) => displayModel(usage.model)).join(", ")}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
                  {COUNT_FORMAT.format(totals.request_count)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted">
                  {formatTokens(totals.input_tokens)} / {formatTokens(totals.output_tokens)}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right">
                  <SpendCell
                    costUsd={totals.cost_usd}
                    estimatedCostUsd={totals.estimated_cost_usd}
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-muted">
                  <LocalDateTime value={key.last_used_at} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type PlatformTableProps = {
  providers: ProviderUsage[];
  view: TelemetryViewState;
};

/**
 * One row per provider ("platform") the window's traffic dispatched to,
 * biggest all-spend first — the backend rollup owns the ordering. A null
 * provider groups the requests that never reached one, surfaced honestly
 * instead of dropped. The model and agent filters have no per-platform
 * dimension in this rollup, so the header says so rather than silently
 * ignoring them.
 */
function PlatformTable({ providers, view }: PlatformTableProps) {
  if (providers.length === 0) {
    return (
      <p className="m-0 px-3.5 py-3 text-[12px] text-muted">
        No usage matches the current window.
      </p>
    );
  }
  const filtered = view.model !== null || view.agentId !== null || view.lane !== null;
  return (
    <div className="p-3.5">
      {filtered && (
        <p className="m-0 mb-2 text-[11px] text-muted-2">
          Platform rollups cover the whole window; the model, agent, and lane filters do not
          apply here.
        </p>
      )}
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted-2">
            <th className="px-2 py-2 font-semibold">Platform</th>
            <th className="px-2 py-2 text-right font-semibold">Requests</th>
            <th className="px-2 py-2 text-right font-semibold">Error rate</th>
            <th className="px-2 py-2 text-right font-semibold">Tokens in/out</th>
            <th className="px-2 py-2 text-right font-semibold">Spend</th>
            <th className="px-2 py-2 text-right font-semibold">Last used</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr className="border-b border-line" key={provider.provider ?? "(none)"}>
              <td className="whitespace-nowrap px-2 py-2 font-medium text-ink">
                {provider.provider === null
                  ? "Not dispatched"
                  : modelProviderLabel(provider.provider)}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted">
                {COUNT_FORMAT.format(provider.request_count)}
              </td>
              <td
                className={clsx(
                  "whitespace-nowrap px-2 py-2 text-right tabular-nums",
                  provider.error_count > 0 ? "text-danger" : "text-muted"
                )}
              >
                {provider.request_count > 0
                  ? `${((provider.error_count / provider.request_count) * 100).toFixed(1)}%`
                  : "0.0%"}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums text-muted">
                {formatTokens(provider.input_tokens)} / {formatTokens(provider.output_tokens)}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right">
                <SpendCell
                  costUsd={provider.cost_usd}
                  estimatedCostUsd={provider.estimated_cost_usd}
                />
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right text-muted">
                <LocalDateTime value={provider.last_used_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sumModels(models: KeyModelUsage[]): Omit<KeyModelUsage, "model"> {
  return models.reduce(
    (totals, usage) => ({
      request_count: totals.request_count + usage.request_count,
      error_count: totals.error_count + usage.error_count,
      input_tokens: totals.input_tokens + usage.input_tokens,
      output_tokens: totals.output_tokens + usage.output_tokens,
      cost_usd: totals.cost_usd + usage.cost_usd,
      estimated_cost_usd: totals.estimated_cost_usd + usage.estimated_cost_usd
    }),
    {
      request_count: 0,
      error_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      estimated_cost_usd: 0
    }
  );
}
