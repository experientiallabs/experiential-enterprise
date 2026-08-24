"use client";

import { formatMetricValue, type DailyPoint, type UsageMetric } from "@/lib/gateway-usage";
import { useMeasuredSize } from "@/lib/use-measured-size";

// GitHub-style contribution graph, house-drawn, but stretched to fill the full
// width of its card: weeks are columns (Sunday on top), and the column pitch is
// derived from the measured width so a fixed 90-day window always spans the
// whole card edge to edge — never a small cluster on the left with dead space
// to its right (the product owner, round-2). Cell height is capped so filling a wide card
// widens the cells rather than growing the graph tall (the page must not
// scroll); intensity is the one brand accent at four opacities, an empty day a
// hairline-gray cell.
const WEEKDAY_GUTTER = 26;
const MONTH_ROW = 16;
const H_GAP = 3; // horizontal gap between week columns
const V_GAP = 3; // vertical gap between day rows
const MAX_CELL = 15; // caps cell height so a wide card stays short, not tall
const FALLBACK_PITCH = 16; // column pitch before the width is measured (SSR/tests)
const WEEKDAY_LABELS: readonly { row: number; label: string }[] = [
  { row: 1, label: "Mon" },
  { row: 3, label: "Wed" },
  { row: 5, label: "Fri" }
];
const LEVEL_OPACITY: readonly number[] = [0.25, 0.5, 0.75, 1];

/**
 * A day's intensity level, 0–4: zero activity is 0, anything else lands in
 * the quarter of the window's max it falls into. Max-relative on purpose —
 * quantiles would repaint history whenever one outlier day lands.
 */
export function contributionLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
}

type ContributionGraphProps = {
  /** Zero-filled per-day series, oldest first (lib/gateway-usage dailySeries). */
  series: DailyPoint[];
  metric: UsageMetric;
};

type Cell = DailyPoint & { week: number; row: number };

export function ContributionGraph({ series, metric }: ContributionGraphProps) {
  const { ref, size } = useMeasuredSize<HTMLDivElement>();

  if (series.length === 0) {
    return null;
  }

  // Sunday-start columns: the first day's weekday offsets it down its column.
  const startOffset = new Date(`${series[0].day}T00:00:00Z`).getUTCDay();
  const cells: Cell[] = series.map((point, index) => ({
    ...point,
    week: Math.floor((startOffset + index) / 7),
    row: (startOffset + index) % 7
  }));
  const weeks = cells[cells.length - 1].week + 1;
  const max = Math.max(...cells.map((cell) => cell.value));

  // Fill the measured width: the column pitch is whatever spreads every week
  // across the card. Cells fill the pitch horizontally and cap their height so
  // a wide card produces wide cells, not a tall graph.
  const measuredWidth = size?.width ?? 0;
  const width = measuredWidth > 0 ? measuredWidth : WEEKDAY_GUTTER + weeks * FALLBACK_PITCH;
  const pitch = weeks > 0 ? (width - WEEKDAY_GUTTER) / weeks : 0;
  const cellWidth = Math.max(1, pitch - H_GAP);
  const cellHeight = Math.max(1, Math.min(cellWidth, MAX_CELL));
  const rowPitch = cellHeight + V_GAP;
  const height = MONTH_ROW + 7 * rowPitch;

  // One label where a column starts a new month, dropped when it would crowd
  // the previous label (short months at narrow pitches overlap otherwise).
  const monthLabels: { week: number; label: string }[] = [];
  let previousMonth: string | null = null;
  for (let week = 0; week < weeks; week += 1) {
    const first = cells.find((cell) => cell.week === week);
    if (!first) {
      continue;
    }
    const at = new Date(`${first.day}T00:00:00Z`);
    const month = `${at.getUTCFullYear()}-${at.getUTCMonth()}`;
    if (month !== previousMonth) {
      const label = at.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
      const last = monthLabels[monthLabels.length - 1];
      if (previousMonth === null || last === undefined || week - last.week >= 2) {
        monthLabels.push({
          week,
          label: at.getUTCMonth() === 0 ? `${label} ${at.getUTCFullYear()}` : label
        });
      }
      previousMonth = month;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="w-full" data-testid="contribution-graph" ref={ref}>
        <svg
          aria-label={`Daily activity, ${series[0].day} to ${series[series.length - 1].day}`}
          height={height}
          role="img"
          width={width}
        >
          {monthLabels.map(({ week, label }) => (
            <text
              className="fill-ink-faint font-mono text-[9px] uppercase tracking-[0.08em]"
              key={`${week}-${label}`}
              x={WEEKDAY_GUTTER + week * pitch}
              y={10}
            >
              {label}
            </text>
          ))}
          {WEEKDAY_LABELS.map(({ row, label }) => (
            <text
              className="fill-ink-faint font-mono text-[9px] uppercase tracking-[0.08em]"
              key={label}
              x={0}
              y={MONTH_ROW + row * rowPitch + cellHeight - 1}
            >
              {label}
            </text>
          ))}
          {cells.map((cell) => {
            const level = contributionLevel(cell.value, max);
            return (
              <rect
                data-day={cell.day}
                data-level={level}
                fill={level === 0 ? "var(--line)" : "var(--accent)"}
                fillOpacity={level === 0 ? 1 : LEVEL_OPACITY[level - 1]}
                height={cellHeight}
                key={cell.day}
                rx={2}
                width={cellWidth}
                x={WEEKDAY_GUTTER + cell.week * pitch}
                y={MONTH_ROW + cell.row * rowPitch}
              >
                <title>{`${formatMetricValue(metric, cell.value)} on ${cell.day}`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center justify-end gap-1 text-[10px] text-ink-faint">
        <span className="mr-1">Less</span>
        <svg aria-hidden height={10} width={68}>
          <rect fill="var(--line)" height={10} rx={2} width={10} x={0} y={0} />
          {LEVEL_OPACITY.map((opacity, index) => (
            <rect
              fill="var(--accent)"
              fillOpacity={opacity}
              height={10}
              key={opacity}
              rx={2}
              width={10}
              x={(index + 1) * 12}
              y={0}
            />
          ))}
        </svg>
        <span className="ml-1">More</span>
      </div>
    </div>
  );
}
