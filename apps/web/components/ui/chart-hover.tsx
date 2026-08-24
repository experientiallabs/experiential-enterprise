"use client";

// The shared hover layer for the house SVG bar charts (the Overview hero and
// the Insights stacked charts): one slot-math helper, one clamped tooltip
// shell, one legend row, one series-color rule. Both charts consume these so
// a positioning or color fix can never land in one copy and not the other.

import type { MouseEvent, ReactNode } from "react";

// The palette's home module (this branch's export seam moved it out of the
// archived projects chart, which now imports it from here too).
import { SERIES_PALETTE } from "@/components/telemetry-page/chart-palette";
import { OTHER_SERIES_KEY } from "@/lib/gateway-usage";

/**
 * The "Other" fold's recessive gray — never a palette hue, so the tail bucket
 * cannot impersonate a ranked model (palettes cycle; the fold must not).
 */
const OTHER_COLOR = "#9ca3af";

/**
 * The Overview hero's ramp: the shared six-color palette plus two spaced hues
 * so its eight named models each keep a distinct color (the first six stay
 * identical wherever SERIES_PALETTE paints them). Lives here so the chart's
 * segments and the top-models rail beside it derive from ONE assignment.
 */
export const MODEL_SERIES_PALETTE = [...SERIES_PALETTE, "#7c3aed", "#db2777"];

/** A series' color: its rank hue from the given ramp; the Other fold is gray. */
export function seriesColor(key: string, index: number, palette: readonly string[]): string {
  return key === OTHER_SERIES_KEY ? OTHER_COLOR : palette[index % palette.length];
}

/**
 * The hovered column for a mouse position over a slotted bar plot, or null
 * outside the plot area. The caller owns the hover state; this is just the
 * shared slot math.
 */
export function hoverIndexFromEvent(
  event: MouseEvent<HTMLElement>,
  marginLeft: number,
  plotWidth: number,
  slot: number,
  count: number
): number | null {
  if (slot <= 0 || count <= 0) {
    return null;
  }
  const x = event.clientX - event.currentTarget.getBoundingClientRect().left - marginLeft;
  if (x < 0 || x > plotWidth) {
    return null;
  }
  return Math.min(count - 1, Math.max(0, Math.floor(x / slot)));
}

// The tooltip's width budget; position clamps against it so the bubble stays
// inside the chart's box even at narrow widths (where it also shrinks).
const TOOLTIP_MAX_WIDTH = 280;
const TOOLTIP_GAP = 8;

type ChartTooltipProps = {
  /** The measured chart width the tooltip must stay within. */
  chartWidth: number;
  marginLeft: number;
  slot: number;
  /** Hovered column index; the bubble sits beside its bar. */
  index: number;
  count: number;
  testId: string;
  children: ReactNode;
};

/**
 * The positioned tooltip shell: beside the hovered bar, flipped across the
 * plot's midpoint, and clamped to the chart's box so it never escapes the
 * card. Content is the caller's.
 */
export function ChartTooltip({
  chartWidth,
  marginLeft,
  slot,
  index,
  count,
  testId,
  children
}: ChartTooltipProps) {
  const budget = Math.max(0, chartWidth - Math.min(TOOLTIP_MAX_WIDTH, chartWidth));
  const style =
    index < count / 2
      ? { left: Math.min(marginLeft + (index + 1) * slot + TOOLTIP_GAP, budget) }
      : { right: Math.min(chartWidth - marginLeft - index * slot + TOOLTIP_GAP, budget) };
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 w-max min-w-[160px] rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2 text-[11px] shadow-lg"
      data-testid={testId}
      style={{ ...style, maxWidth: Math.min(TOOLTIP_MAX_WIDTH, chartWidth) }}
    >
      {children}
    </div>
  );
}

/** One tooltip breakdown row: color chip, truncating label, right-side value. */
export function TooltipRow({
  color,
  label,
  value
}: {
  color: string;
  label: string;
  value: ReactNode;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
        <span className="truncate text-ink">{label}</span>
      </span>
      <span className="shrink-0 whitespace-nowrap font-mono text-muted">{value}</span>
    </li>
  );
}

/** The named legend row under a stacked chart, swatches in series order. */
export function LegendSwatches({
  entries,
  className
}: {
  entries: { key: string; label: string; color: string }[];
  className?: string;
}) {
  return (
    <p className={`m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-2 ${className ?? ""}`}>
      {entries.map((entry) => (
        <span className="flex items-center gap-1.5" key={entry.key}>
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ backgroundColor: entry.color }}
          />
          {entry.label}
        </span>
      ))}
    </p>
  );
}
