import { AlertTriangle, Coins, Layers, Users } from "lucide-react";
import type { ComponentType } from "react";

import {
  agentLabel,
  allSpendUsd,
  displayModel,
  modelRollups,
  usageTotals
} from "@/lib/gateway-telemetry";
import { formatCostUsd } from "@/lib/money";
import type { UsageByKey, UsageByPrompt, UsageTimeseries } from "@/lib/types";

// One ranked bar row: a label, a formatted value, an optional annotation, and
// its share of the card's peak for the bar width.
type BarRow = {
  label: string;
  value: string;
  detail: string | null;
  fraction: number;
};

function BarList({ rows }: { rows: BarRow[] }) {
  return (
    <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
      {rows.map((row) => (
        <li className="flex flex-col gap-1" key={row.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[12px] text-ink">{row.label}</span>
            <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink">
              {row.value}
              {row.detail !== null && (
                <span className="ml-1.5 font-normal text-muted-2">{row.detail}</span>
              )}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round(row.fraction * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function InsightCard({
  icon: Icon,
  title,
  hint,
  rows
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;
  title: string;
  hint: string;
  rows: BarRow[];
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      <header className="flex items-center gap-2">
        <Icon aria-hidden className="text-muted" size={15} strokeWidth={1.8} />
        <h3 className="m-0 text-[13px] font-semibold text-ink">{title}</h3>
      </header>
      <p className="m-0 mt-0.5 text-[11px] text-muted-2">{hint}</p>
      <BarList rows={rows} />
    </section>
  );
}

const MAX_ROWS = 5;

type InsightCardsProps = {
  timeseries: UsageTimeseries;
  byKey: UsageByKey;
  byPrompt: UsageByPrompt;
};

/**
 * The real, usage-tied insight cards: where spend goes, where errors cluster,
 * and which agents drive traffic — all derived from the org's own aggregates
 * with the same helpers the Telemetry page uses. Each card renders only when it
 * has real data; nothing is invented, and an all-quiet org shows no cards (the
 * page frames the empty state around this component).
 */
export function InsightCards({ timeseries, byKey, byPrompt }: InsightCardsProps) {
  const rollups = modelRollups(timeseries.buckets);
  const totals = usageTotals(timeseries.buckets);
  const cards = [];

  // Repeated prompts — requests grouped by the same system prompt + tools
  // (content-free lineage digests). The biggest groups are where caching and
  // prompt work pay off, so this card leads when groups exist.
  const promptRows = byPrompt.prompts.slice(0, MAX_ROWS);
  if (promptRows.length > 0) {
    const busiest = promptRows[0].request_count;
    cards.push(
      <InsightCard
        hint="Requests that resent the same system prompt and tools this window, grouped without storing any content."
        icon={Layers}
        key="prompts"
        rows={promptRows.map((row) => ({
          // Captured orgs see their actual prompt text; everyone else the
          // content-free digest handle.
          label:
            row.prompt_snippet !== null && row.prompt_snippet.length > 0
              ? `${displayModel(row.model)} · “${row.prompt_snippet.slice(0, 60)}${row.prompt_snippet.length > 60 ? "…" : ""}”`
              : `${displayModel(row.model)} · ${row.prompt_group.slice(0, 8)}`,
          value: `${row.request_count.toLocaleString("en-US")}`,
          detail: `${row.conversation_count} conv · ~${row.stable_prefix_tokens_estimate.toLocaleString("en-US")} tok prefix (est.)`,
          fraction: busiest > 0 ? row.request_count / busiest : 0
        }))}
        title="Repeated prompts"
      />
    );
  }

  // Spend by model — the biggest lever, so it leads. Only when there is spend.
  const spendPeak = rollups.length > 0 ? allSpendUsd(rollups[0]) : 0;
  if (spendPeak > 0) {
    cards.push(
      <InsightCard
        hint="Your all-spend by model this window (platform credits plus estimated pass-through)."
        icon={Coins}
        key="spend"
        rows={rollups
          .filter((rollup) => allSpendUsd(rollup) > 0)
          .slice(0, MAX_ROWS)
          .map((rollup) => ({
            label: displayModel(rollup.model),
            value: formatCostUsd(allSpendUsd(rollup)),
            detail: null,
            fraction: allSpendUsd(rollup) / spendPeak
          }))}
        title="Where your spend goes"
      />
    );
  }

  // Error hotspots — models with a non-zero error rate, worst first.
  const errorRows = rollups
    .filter((rollup) => rollup.errorCount > 0)
    .map((rollup) => ({
      model: rollup.model,
      rate: rollup.errorCount / rollup.requestCount,
      errorCount: rollup.errorCount,
      requestCount: rollup.requestCount
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, MAX_ROWS);
  if (errorRows.length > 0) {
    const worst = errorRows[0].rate;
    cards.push(
      <InsightCard
        hint="Models returning errors this window. Filter the request log to errors to see what failed."
        icon={AlertTriangle}
        key="errors"
        rows={errorRows.map((row) => ({
          label: displayModel(row.model),
          value: `${(row.rate * 100).toFixed(1)}%`,
          detail: `${row.errorCount} of ${row.requestCount}`,
          fraction: worst > 0 ? row.rate / worst : 0
        }))}
        title="Error hotspots"
      />
    );
  }

  // Busiest agents — the API keys driving traffic, by request count.
  const agentRows = byKey.keys
    .map((key) => ({
      label: agentLabel(key.api_key_id, key.key_label),
      requests: key.totals.request_count
    }))
    .filter((row) => row.requests > 0)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, MAX_ROWS);
  if (agentRows.length > 0) {
    const busiest = agentRows[0].requests;
    cards.push(
      <InsightCard
        hint="The API keys (agents) sending the most requests this window."
        icon={Users}
        key="agents"
        rows={agentRows.map((row) => ({
          label: row.label,
          value: `${row.requests.toLocaleString("en-US")}`,
          detail: "requests",
          fraction: busiest > 0 ? row.requests / busiest : 0
        }))}
        title="Busiest agents"
      />
    );
  }

  if (cards.length === 0 && totals.requestCount === 0 && byKey.keys.length === 0) {
    return null;
  }

  return <div className="grid gap-4 lg:grid-cols-2">{cards}</div>;
}
