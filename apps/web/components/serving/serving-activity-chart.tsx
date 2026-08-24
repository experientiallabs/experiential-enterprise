"use client";

import { useMemo } from "react";

import { fillServingBuckets } from "@/lib/serving-telemetry";
import type { ServingBucket, ServingWindow } from "@/lib/types";
import { useMeasuredSize } from "@/lib/use-measured-size";

// House hand-rolled SVG chart: measured frame, ink bars on hairline
// gridlines, errors overlaid in the danger token from the bar's base.
const MARGINS = { left: 34, right: 8, top: 8, bottom: 20 };
const MIN_BAR_GAP = 2;

type ServingActivityChartProps = {
  buckets: ServingBucket[];
  bucketSeconds: number;
  window: ServingWindow;
  /** Server-provided clock so the filled series is stable across hydration. */
  nowMs: number;
};

export function ServingActivityChart({
  buckets,
  bucketSeconds,
  window: windowKey,
  nowMs
}: ServingActivityChartProps) {
  const { ref, size } = useMeasuredSize<HTMLDivElement>();
  const series = useMemo(
    () => fillServingBuckets(buckets, bucketSeconds, windowKey, nowMs),
    [buckets, bucketSeconds, windowKey, nowMs]
  );
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const plotWidth = width - MARGINS.left - MARGINS.right;
  const plotHeight = height - MARGINS.top - MARGINS.bottom;
  const maxCount = Math.max(1, ...series.map((bucket) => bucket.request_count));
  const slot = series.length > 0 ? plotWidth / series.length : 0;
  const barWidth = Math.max(1, slot - MIN_BAR_GAP);

  const timeLabel = (iso: string): string => {
    const at = new Date(iso);
    return windowKey === "24h"
      ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const totalRequests = series.reduce((sum, bucket) => sum + bucket.request_count, 0);
  const totalErrors = series.reduce((sum, bucket) => sum + bucket.error_count, 0);
  // Dedupe rounded tick labels: at tiny maxima both gridlines round to the
  // same integer and the axis reads as a duplicate.
  const fractions = Math.round(maxCount * 0.5) < Math.round(maxCount) ? [1, 0.5] : [1];

  return (
    <div className="h-[120px] w-full overflow-hidden" ref={ref}>
      <span className="sr-only">
        {`Requests over time: ${totalRequests} requests, ${totalErrors} errors in this window.`}
      </span>
      {plotWidth > 0 && plotHeight > 0 && (
        <svg aria-hidden height={height} width={width}>
          {fractions.map((fraction) => (
            <g key={fraction}>
              <line
                stroke="#ededed"
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
                {Math.round(maxCount * fraction).toLocaleString()}
              </text>
            </g>
          ))}
          <line
            stroke="#ededed"
            strokeWidth="1"
            x1={MARGINS.left}
            x2={width - MARGINS.right}
            y1={MARGINS.top + plotHeight}
            y2={MARGINS.top + plotHeight}
          />
          {series.map((bucket, index) => {
            const x = MARGINS.left + index * slot + (slot - barWidth) / 2;
            // Clamp the error overlay to the rendered bar so min-height
            // rounding can never draw errors taller than their own bucket.
            const barHeight = Math.max((bucket.request_count / maxCount) * plotHeight, 2);
            const errorHeight = Math.min(
              Math.max((bucket.error_count / maxCount) * plotHeight, 2),
              barHeight
            );
            return (
              <g key={bucket.bucket_start}>
                {bucket.request_count > 0 && (
                  <rect
                    fill="#1a1a1a"
                    height={barHeight}
                    rx={1}
                    width={barWidth}
                    x={x}
                    y={MARGINS.top + plotHeight - barHeight}
                  />
                )}
                {bucket.error_count > 0 && (
                  <rect
                    fill="var(--danger)"
                    height={errorHeight}
                    rx={1}
                    width={barWidth}
                    x={x}
                    y={MARGINS.top + plotHeight - errorHeight}
                  />
                )}
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
                {timeLabel(series[0].bucket_start)}
              </text>
              <text
                className="fill-muted text-[10px]"
                textAnchor="end"
                x={width - MARGINS.right}
                y={height - 6}
              >
                {timeLabel(series[series.length - 1].bucket_start)}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}
