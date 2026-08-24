"use client";

import { SERIES_PALETTE } from "@/components/telemetry-page/chart-palette";
import type { SpendChartData } from "@/lib/gateway-telemetry";
import { dollarFormatter } from "@/lib/money";
import type { ServingWindow } from "@/lib/types";
import { useMeasuredSize } from "@/lib/use-measured-size";

// House hand-rolled SVG, thin-line form: one hairline path per series over
// gridlines, colors from the shared series ramp, legend named below the plot.
const MARGINS = { left: 46, right: 10, top: 10, bottom: 22 };
const GRID = "#f1f1f1";

type SpendChartProps = {
  data: SpendChartData;
  window: ServingWindow;
};

/**
 * Spend over time. The caller chooses the series split (per lane or per
 * model); this component only draws. Dollar ticks share one format chosen by
 * the smallest visible figure so the axis stays comparable.
 */
export function SpendChart({ data, window: windowKey }: SpendChartProps) {
  const { ref, size } = useMeasuredSize<HTMLDivElement>();
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const plotWidth = width - MARGINS.left - MARGINS.right;
  const plotHeight = height - MARGINS.top - MARGINS.bottom;
  const { starts, series } = data;
  const maxUsd = Math.max(0, ...series.flatMap((entry) => entry.points));
  // A zero window still draws its axis; the scale floor keeps 0/0 off NaN.
  const scaleUsd = maxUsd > 0 ? maxUsd : 1;
  const formatUsd = dollarFormatter([maxUsd, maxUsd / 2]);

  const x = (index: number): number =>
    MARGINS.left + (starts.length > 1 ? (index / (starts.length - 1)) * plotWidth : plotWidth / 2);
  const y = (usd: number): number => MARGINS.top + plotHeight * (1 - usd / scaleUsd);

  const timeLabel = (atMs: number): string => {
    const at = new Date(atMs);
    return windowKey === "24h"
      ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const totalUsd = series.reduce(
    (sum, entry) => sum + entry.points.reduce((s, value) => s + value, 0),
    0
  );

  return (
    <div className="flex flex-col gap-1.5" data-testid="spend-chart">
      <div className="h-[180px] w-full overflow-hidden" ref={ref}>
        <span className="sr-only">
          {`Spend over time: ${formatUsd(totalUsd)} across ${series.length} series in this window.`}
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
                  y1={y(scaleUsd * fraction)}
                  y2={y(scaleUsd * fraction)}
                />
                <text
                  className="fill-muted text-[10px]"
                  textAnchor="end"
                  x={MARGINS.left - 6}
                  y={y(scaleUsd * fraction) + 3}
                >
                  {formatUsd(maxUsd * fraction)}
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
            {series.map((entry, index) => (
              <polyline
                fill="none"
                key={entry.key}
                points={entry.points.map((usd, at) => `${x(at)},${y(usd)}`).join(" ")}
                stroke={SERIES_PALETTE[index % SERIES_PALETTE.length]}
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            ))}
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
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-2">
        {series.map((entry, index) => (
          <span className="flex items-center gap-1.5" key={entry.key}>
            <span
              aria-hidden
              className="inline-block h-[2px] w-3 rounded-full"
              style={{ backgroundColor: SERIES_PALETTE[index % SERIES_PALETTE.length] }}
            />
            {entry.label}
          </span>
        ))}
      </p>
    </div>
  );
}
