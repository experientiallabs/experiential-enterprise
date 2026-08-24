"use client";

import { useState, type MouseEvent } from "react";

import { SERIES_PALETTE } from "@/components/telemetry-page/chart-palette";
import {
  ChartTooltip,
  hoverIndexFromEvent,
  LegendSwatches,
  seriesColor,
  TooltipRow
} from "@/components/ui/chart-hover";
import type { SpendChartData } from "@/lib/gateway-telemetry";
import type { ServingWindow } from "@/lib/types";
import { useMeasuredSize } from "@/lib/use-measured-size";

// House hand-rolled SVG, stacked-bar form (the OpenRouter Activity look): one
// bar per bucket, segments stacked per series in the shared color ramp (the
// Other fold in chart-hover's recessive gray), a named legend below, and a
// per-bucket hover tooltip with the model breakdown. The caller owns the value
// formatting so the axis and tooltip read in the chart's own units (dollars,
// tokens, requests).
const MARGINS = { left: 46, right: 10, top: 10, bottom: 22 };
const GRID = "#f1f1f1";
const MIN_BAR_GAP = 2;

type StackedBarChartProps = {
  data: SpendChartData;
  window: ServingWindow;
  /** Formats an axis tick and the accessible total in the chart's units. */
  format: (value: number) => string;
  /** Screen-reader summary noun, e.g. "tokens" or "requests". */
  unitLabel: string;
};

export function StackedBarChart({ data, window: windowKey, format, unitLabel }: StackedBarChartProps) {
  const { ref, size } = useMeasuredSize<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const plotWidth = width - MARGINS.left - MARGINS.right;
  const plotHeight = height - MARGINS.top - MARGINS.bottom;
  const { starts, series } = data;

  // Per-bucket stack totals set the scale; the tallest bar tops the axis.
  const columnTotals = starts.map((_, column) =>
    series.reduce((sum, entry) => sum + (entry.points[column] ?? 0), 0)
  );
  const maxTotal = Math.max(0, ...columnTotals);
  const scale = maxTotal > 0 ? maxTotal : 1;
  const grandTotal = columnTotals.reduce((sum, value) => sum + value, 0);

  const slot = starts.length > 0 ? plotWidth / starts.length : 0;
  const barWidth = Math.max(1, slot - MIN_BAR_GAP);
  const y = (value: number): number => MARGINS.top + plotHeight * (1 - value / scale);

  const timeLabel = (atMs: number): string => {
    const at = new Date(atMs);
    return windowKey === "24h"
      ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  // The hovered bucket's per-series breakdown (active series only).
  const hovered =
    hoverIndex === null
      ? null
      : series
          .map((entry, index) => ({
            key: entry.key,
            label: entry.label,
            color: seriesColor(entry.key, index, SERIES_PALETTE),
            value: entry.points[hoverIndex] ?? 0
          }))
          .filter((row) => row.value > 0);

  function onMouseMove(event: MouseEvent<HTMLDivElement>) {
    setHoverIndex(hoverIndexFromEvent(event, MARGINS.left, plotWidth, slot, starts.length));
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="stacked-bar-chart">
      <div className="relative">
        <div
          className="h-[180px] w-full overflow-hidden"
          onMouseLeave={() => setHoverIndex(null)}
          onMouseMove={onMouseMove}
          ref={ref}
        >
          <span className="sr-only">
            {`Usage over time: ${format(grandTotal)} ${unitLabel} across ${series.length} models in this window.`}
          </span>
          {plotWidth > 0 && plotHeight > 0 && (
            <svg aria-hidden height={height} width={width}>
              {[1, 0.5].map((fraction) => (
                <g key={fraction}>
                  <line
                    stroke={GRID}
                    strokeWidth="1"
                    x1={MARGINS.left}
                    x2={width - MARGINS.right}
                    y1={y(scale * fraction)}
                    y2={y(scale * fraction)}
                  />
                  <text
                    className="fill-muted text-[10px]"
                    textAnchor="end"
                    x={MARGINS.left - 6}
                    y={y(scale * fraction) + 3}
                  >
                    {format(maxTotal * fraction)}
                  </text>
                </g>
              ))}
              <line
                stroke={GRID}
                strokeWidth="1"
                x1={MARGINS.left}
                x2={width - MARGINS.right}
                y1={MARGINS.top + plotHeight}
                y2={MARGINS.top + plotHeight}
              />
              {hoverIndex !== null && hovered !== null && hovered.length > 0 && (
                <rect
                  fill="var(--surface-subtle)"
                  height={plotHeight}
                  width={slot}
                  x={MARGINS.left + hoverIndex * slot}
                  y={MARGINS.top}
                />
              )}
              {starts.map((_, column) => {
                const x = MARGINS.left + column * slot + (slot - barWidth) / 2;
                let cursor = MARGINS.top + plotHeight;
                return series.map((entry, seriesIndex) => {
                  const value = entry.points[column] ?? 0;
                  if (value <= 0) {
                    return null;
                  }
                  const segmentHeight = (value / scale) * plotHeight;
                  cursor -= segmentHeight;
                  return (
                    <rect
                      fill={seriesColor(entry.key, seriesIndex, SERIES_PALETTE)}
                      height={segmentHeight}
                      key={`${column}-${entry.key}`}
                      stroke="var(--surface)"
                      strokeWidth={segmentHeight > 2 ? 0.75 : 0}
                      width={barWidth}
                      x={x}
                      y={cursor}
                    />
                  );
                });
              })}
              {starts.length > 1 && (
                <>
                  <text
                    className="fill-muted text-[10px]"
                    textAnchor="start"
                    x={MARGINS.left}
                    y={height - 6}
                  >
                    {timeLabel(starts[0])}
                  </text>
                  <text
                    className="fill-muted text-[10px]"
                    textAnchor="end"
                    x={width - MARGINS.right}
                    y={height - 6}
                  >
                    {timeLabel(starts[starts.length - 1])}
                  </text>
                </>
              )}
            </svg>
          )}
        </div>
        {hoverIndex !== null && hovered !== null && hovered.length > 0 && (
          <ChartTooltip
            chartWidth={width}
            count={starts.length}
            index={hoverIndex}
            marginLeft={MARGINS.left}
            slot={slot}
            testId="stacked-bar-tooltip"
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-medium text-ink">{timeLabel(starts[hoverIndex])}</span>
              <span className="font-mono font-semibold text-ink">
                {format(columnTotals[hoverIndex])}
              </span>
            </div>
            <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
              {hovered.map((row) => (
                <TooltipRow color={row.color} key={row.key} label={row.label} value={format(row.value)} />
              ))}
            </ul>
          </ChartTooltip>
        )}
      </div>
      <LegendSwatches
        entries={series.map((entry, index) => ({
          key: entry.key,
          label: entry.label,
          color: seriesColor(entry.key, index, SERIES_PALETTE)
        }))}
      />
    </div>
  );
}
