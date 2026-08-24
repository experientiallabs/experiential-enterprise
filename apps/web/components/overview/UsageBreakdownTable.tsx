"use client";

import type { ReactNode } from "react";
import { clsx } from "clsx";

import { ErrorTile } from "@/components/ui/ErrorTile";
import { Shimmer } from "@/components/ui/Shimmer";
import {
  formatMetricValue,
  metricValue,
  type UsageMetric,
  type UsageMetricRow
} from "@/lib/gateway-usage";

/**
 * One "grouped usage for the period, spend-leaders first" table: the
 * Overview's member breakdown and the admin Telemetry panel's org breakdown
 * share the active-row filter, the metric sort, the "{n} active X this
 * period" header, and the Requests/Tokens/Spend columns; only the grouped
 * dimension (name cell, row key, selection) belongs to the caller. A failed
 * read renders as an error tile so the table never dies silently — in the
 * admin panel this table is the drilldown's only navigation.
 */
export function UsageBreakdownTable<T extends UsageMetricRow>({
  rows,
  metric,
  loading,
  error = null,
  title,
  columnHeader,
  activeNoun,
  emptyText,
  testId,
  className,
  rowKey,
  renderName,
  isSelected
}: {
  rows: T[] | null;
  metric: UsageMetric;
  loading: boolean;
  error?: string | null;
  title: string;
  /** The first column's header: "Member", "Organization". */
  columnHeader: string;
  /** The "{n} active X this period" noun: "member", "org". */
  activeNoun: string;
  emptyText: string;
  testId: string;
  className?: string;
  rowKey: (row: T) => string;
  renderName: (row: T) => ReactNode;
  /** Highlights the row (the admin panel's drilled-into org). */
  isSelected?: (row: T) => boolean;
}) {
  const active = rows === null ? null : rows.filter((row) => metricValue(row, metric) > 0);
  const sorted =
    active === null
      ? null
      : [...active].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  return (
    <section
      className={clsx(
        "flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]",
        className
      )}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="mono-label">{title}</span>
        {sorted !== null && (
          <span className="text-[12px] text-muted">
            {sorted.length === 1 ? `1 active ${activeNoun}` : `${sorted.length} active ${activeNoun}s`}{" "}
            this period
          </span>
        )}
      </div>
      {sorted === null && error !== null && (
        <ErrorTile message={error} title={`${title} are unavailable`} />
      )}
      {sorted === null && error === null && loading && <Shimmer className="h-[72px]" />}
      {sorted !== null && sorted.length === 0 && (
        <p className="m-0 text-[12px] text-muted-2">{emptyText}</p>
      )}
      {sorted !== null && sorted.length > 0 && (
        // The list scrolls inside its own panel so a long roster never pushes
        // the page past one viewport.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25">
                <th className="py-1.5 font-medium">{columnHeader}</th>
                <th className="py-1.5 text-right font-medium">Requests</th>
                <th className="py-1.5 text-right font-medium">Tokens</th>
                <th className="py-1.5 text-right font-medium">Spend</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr
                  className={clsx(
                    "border-t border-line",
                    isSelected?.(row) === true && "bg-surface-subtle"
                  )}
                  key={rowKey(row)}
                >
                  <td className="max-w-0 overflow-hidden text-ellipsis whitespace-nowrap py-2 pr-3">
                    {renderName(row)}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatMetricValue("requests", metricValue(row, "requests"))}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatMetricValue("tokens", metricValue(row, "tokens"))}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatMetricValue("spend", metricValue(row, "spend"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
