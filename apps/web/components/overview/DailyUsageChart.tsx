"use client";

import { useState, type MouseEvent } from "react";

import { SERIES_PALETTE } from "@/components/telemetry-page/chart-palette";
import {
  ChartTooltip,
  hoverIndexFromEvent,
  LegendSwatches,
  MODEL_SERIES_PALETTE,
  seriesColor,
  TooltipRow
} from "@/components/ui/chart-hover";
import {
  formatMetricValue,
  metricValue,
  type DailyModelStacks,
  type DailyPoint,
  type UsageMetric,
  type UsageMetricRow
} from "@/lib/gateway-usage";
import { formatTokens } from "@/lib/format";
import { useMeasuredSize } from "@/lib/use-measured-size";

// House hand-rolled SVG bars (the serving-activity-chart idiom): measured
// frame, ink bars on hairline gridlines, metric-formatted ticks. The summary
// section's per-day graph for whatever metric and period is selected. With a
// per-model breakdown (the Overview hero), each day's bar stacks by model in
// the shared color ramp with a hover tooltip; without one (the admin
// Telemetry panel, or while the breakdown loads) it stays the flat ink bars.
const MARGINS = { left: 44, right: 8, top: 8, bottom: 20 };
const MIN_BAR_GAP = 2;


type DailyUsageChartProps = {
  /** Zero-filled per-day series, oldest first (lib/gateway-usage dailySeries). */
  series: DailyPoint[];
  metric: UsageMetric;
  /**
   * Per-model stacks over the same range (lib/gateway-usage dailyModelStacks).
   * Their day axis matches `series` by construction — both derive from the
   * group_by=day rows — and segments are looked up by day string regardless.
   */
  stacks?: DailyModelStacks;
};

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

/** The tooltip's secondary trio for one cell, minus the headline metric. */
function secondaryLabel(metric: UsageMetric, cell: UsageMetricRow): string {
  const spend = formatMetricValue("spend", cell.spend_micro_usd);
  const requests = `${cell.requests.toLocaleString("en-US")} req`;
  const tokens = `${formatTokens(cell.input_tokens + cell.output_tokens)} tok`;
  switch (metric) {
    case "spend":
      return `${requests} · ${tokens}`;
    case "requests":
      return `${spend} · ${tokens}`;
    case "tokens":
      return `${spend} · ${requests}`;
  }
}

export function DailyUsageChart({ series, metric, stacks }: DailyUsageChartProps) {
  const { ref, size } = useMeasuredSize<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const plotWidth = width - MARGINS.left - MARGINS.right;
  const plotHeight = height - MARGINS.top - MARGINS.bottom;
  const maxValue = Math.max(1, ...series.map((point) => point.value));
  const slot = series.length > 0 ? plotWidth / series.length : 0;
  const barWidth = Math.max(1, slot - MIN_BAR_GAP);
  const total = series.reduce((sum, point) => sum + point.value, 0);
  // Dedupe rounded tick labels: at tiny maxima both gridlines format to the
  // same string and the axis reads as a duplicate.
  const fractions =
    formatMetricValue(metric, maxValue * 0.5) !== formatMetricValue(metric, maxValue)
      ? [1, 0.5]
      : [1];

  // Segments per day, keyed by day string so a mid-flight stacks refresh can
  // never smear one day's mix onto a neighbor.
  const stackIndexByDay =
    stacks === undefined ? null : new Map(stacks.days.map((day, index) => [day, index]));

  const hovered =
    hoverIndex !== null && stacks !== undefined && stackIndexByDay !== null && series[hoverIndex]
      ? hoveredDetail(stacks, stackIndexByDay, series[hoverIndex].day)
      : null;

  function onMouseMove(event: MouseEvent<HTMLDivElement>) {
    if (stacks === undefined) {
      return;
    }
    setHoverIndex(hoverIndexFromEvent(event, MARGINS.left, plotWidth, slot, series.length));
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="daily-usage-chart">
      {/* The plot keeps its own height floor so a wrapping legend can never
          squeeze it below readability. */}
      <div className="relative min-h-[140px] w-full flex-1">
        <div
          className="h-full w-full overflow-hidden"
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={onMouseMove}
          ref={ref}
        >
          <span className="sr-only">
            {`Per-day usage: ${formatMetricValue(metric, total)} across ${series.length} days.`}
          </span>
          {plotWidth > 0 && plotHeight > 0 && (
            <svg aria-hidden height={height} width={width}>
              {fractions.map((fraction) => (
                <g key={fraction}>
                  <line
                    stroke="var(--line)"
                    strokeWidth="1"
                    x1={MARGINS.left}
                    x2={width - MARGINS.right}
                    y1={MARGINS.top + plotHeight * (1 - fraction)}
                    y2={MARGINS.top + plotHeight * (1 - fraction)}
                  />
                  <text
                    className="fill-muted text-[10px]"
                    textAnchor="end"
                    x={MARGINS.left - 6}
                    y={MARGINS.top + plotHeight * (1 - fraction) + 3}
                  >
                    {formatMetricValue(metric, maxValue * fraction)}
                  </text>
                </g>
              ))}
              <line
                stroke="var(--line)"
                strokeWidth="1"
                x1={MARGINS.left}
                x2={width - MARGINS.right}
                y1={MARGINS.top + plotHeight}
                y2={MARGINS.top + plotHeight}
              />
              {hoverIndex !== null && hovered !== null && (
                <rect
                  fill="var(--surface-subtle)"
                  height={plotHeight}
                  width={slot}
                  x={MARGINS.left + hoverIndex * slot}
                  y={MARGINS.top}
                />
              )}
              {series.map((point, index) => {
                if (point.value <= 0) {
                  return null;
                }
                const barHeight = Math.max((point.value / maxValue) * plotHeight, 2);
                const x = MARGINS.left + index * slot + (slot - barWidth) / 2;
                const stackAt = stackIndexByDay?.get(point.day);
                if (stacks === undefined || stackAt === undefined) {
                  return (
                    <rect
                      fill="var(--ink)"
                      height={barHeight}
                      key={point.day}
                      rx={1}
                      width={barWidth}
                      x={x}
                      y={MARGINS.top + plotHeight - barHeight}
                    >
                      {stacks === undefined && (
                        <title>{`${formatMetricValue(metric, point.value)} on ${point.day}`}</title>
                      )}
                    </rect>
                  );
                }
                // Stacked: segments bottom-up in rank order, scaled so the
                // full stack spans the same bar the flat mode would draw (the
                // day total is the same number by construction). A hairline
                // surface stroke keeps adjacent segments separable even for
                // close hues.
                const dayTotal = stacks.series.reduce(
                  (sum, entry) => sum + metricValue(entry.detail[stackAt], metric),
                  0
                );
                let cursor = MARGINS.top + plotHeight;
                return (
                  <g key={point.day}>
                    {stacks.series.map((entry, seriesIndex) => {
                      const value = metricValue(entry.detail[stackAt], metric);
                      if (value <= 0 || dayTotal <= 0) {
                        return null;
                      }
                      const segmentHeight = (value / dayTotal) * barHeight;
                      cursor -= segmentHeight;
                      return (
                        <rect
                          fill={seriesColor(entry.key, seriesIndex, MODEL_SERIES_PALETTE)}
                          height={segmentHeight}
                          key={entry.key}
                          stroke="var(--surface)"
                          strokeWidth={segmentHeight > 2 ? 0.75 : 0}
                          width={barWidth}
                          x={x}
                          y={cursor}
                        />
                      );
                    })}
                  </g>
                );
              })}
              {series.length > 1 && (
                <>
                  <text
                    className="fill-muted text-[10px]"
                    textAnchor="start"
                    x={MARGINS.left}
                    y={height - 6}
                  >
                    {dayLabel(series[0].day)}
                  </text>
                  <text
                    className="fill-muted text-[10px]"
                    textAnchor="end"
                    x={width - MARGINS.right}
                    y={height - 6}
                  >
                    {dayLabel(series[series.length - 1].day)}
                  </text>
                </>
              )}
            </svg>
          )}
        </div>
        {hoverIndex !== null && hovered !== null && (
          <ChartTooltip
            chartWidth={width}
            count={series.length}
            index={hoverIndex}
            marginLeft={MARGINS.left}
            slot={slot}
            testId="daily-usage-tooltip"
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-medium text-ink">{dayLabel(series[hoverIndex].day)}</span>
              <span className="font-mono font-semibold text-ink">
                {formatMetricValue(metric, series[hoverIndex].value)}
              </span>
            </div>
            <p className="m-0 mb-1.5 text-muted-2">{secondaryLabel(metric, hovered.total)}</p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {hovered.rows.map((row) => (
                <TooltipRow
                  color={row.color}
                  key={row.key}
                  label={row.label}
                  value={
                    <>
                      {formatMetricValue(metric, metricValue(row.cell, metric))}
                      <span className="ml-1.5 text-muted-2">
                        {secondaryLabel(metric, row.cell)}
                      </span>
                    </>
                  }
                />
              ))}
            </ul>
          </ChartTooltip>
        )}
      </div>
      {stacks !== undefined && stacks.series.length > 0 && (
        <LegendSwatches
          className="pt-1.5"
          entries={stacks.series.map((entry, index) => ({
            key: entry.key,
            label: entry.label,
            color: seriesColor(entry.key, index, MODEL_SERIES_PALETTE)
          }))}
        />
      )}
    </div>
  );
}

/** The hovered day's per-model cells (active models only) plus the day total. */
function hoveredDetail(
  stacks: DailyModelStacks,
  stackIndexByDay: Map<string, number>,
  day: string
): { total: UsageMetricRow; rows: { key: string; label: string; color: string; cell: UsageMetricRow }[] } | null {
  const at = stackIndexByDay.get(day);
  if (at === undefined) {
    return null;
  }
  const rows = stacks.series
    .map((entry, index) => ({
      key: entry.key,
      label: entry.label,
      color: seriesColor(entry.key, index, MODEL_SERIES_PALETTE),
      cell: entry.detail[at]
    }))
    .filter(
      (row) =>
        row.cell.requests > 0 ||
        row.cell.spend_micro_usd > 0 ||
        row.cell.input_tokens + row.cell.output_tokens > 0
    );
  if (rows.length === 0) {
    return null;
  }
  return { total: stacks.totals[at], rows };
}
