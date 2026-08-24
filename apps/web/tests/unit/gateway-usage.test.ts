import { describe, expect, it } from "vitest";

import {
  activityStats,
  addDays,
  dailyModelStacks,
  dailySeries,
  deltaPercent,
  formatDeltaPercent,
  formatMetricValue,
  metricValue,
  OTHER_SERIES_KEY,
  periodRange,
  previousPeriodRange,
  rowsInRange,
  sumMetric,
  topGroups,
  type GatewayUsageRow
} from "@/lib/gateway-usage";

const TODAY = "2026-08-19";

function row(overrides: Partial<GatewayUsageRow>): GatewayUsageRow {
  return {
    day: null,
    user_id: null,
    alias: null,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    spend_micro_usd: 0,
    ...overrides
  };
}

describe("addDays", () => {
  it("crosses month and year boundaries in UTC", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("periodRange / previousPeriodRange", () => {
  it("cuts inclusive UTC ranges ending today", () => {
    expect(periodRange("today", TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(periodRange("7d", TODAY)).toEqual({ from: "2026-08-13", to: TODAY });
    expect(periodRange("30d", TODAY)).toEqual({ from: "2026-07-21", to: TODAY });
    expect(periodRange("1y", TODAY)).toEqual({ from: "2025-08-20", to: TODAY });
    expect(periodRange("all", TODAY)).toEqual({ from: null, to: TODAY });
  });

  it("previous period is the equal-length window immediately before", () => {
    expect(previousPeriodRange("today", TODAY)).toEqual({ from: "2026-08-18", to: "2026-08-18" });
    expect(previousPeriodRange("7d", TODAY)).toEqual({ from: "2026-08-06", to: "2026-08-12" });
    expect(previousPeriodRange("30d", TODAY)).toEqual({ from: "2026-06-21", to: "2026-07-20" });
    expect(previousPeriodRange("all", TODAY)).toBeNull();
  });

  it("current and previous windows tile without gap or overlap", () => {
    for (const period of ["today", "7d", "30d", "1y"] as const) {
      const current = periodRange(period, TODAY);
      const previous = previousPeriodRange(period, TODAY);
      expect(previous).not.toBeNull();
      expect(addDays(previous!.to, 1)).toBe(current.from);
    }
  });
});

describe("metricValue / formatMetricValue", () => {
  const sample = row({ requests: 7, input_tokens: 1_000, output_tokens: 500, spend_micro_usd: 2_500_000 });

  it("projects each metric, spend staying in micro-USD", () => {
    expect(metricValue(sample, "requests")).toBe(7);
    expect(metricValue(sample, "tokens")).toBe(1_500);
    expect(metricValue(sample, "spend")).toBe(2_500_000);
  });

  it("formats spend as dollars, tokens compact, requests grouped", () => {
    expect(formatMetricValue("spend", 2_500_000)).toBe("$2.50");
    expect(formatMetricValue("tokens", 24_600)).toBe("24.6k");
    expect(formatMetricValue("requests", 1_234)).toBe("1,234");
  });
});

describe("rowsInRange / sumMetric", () => {
  const rows = [
    row({ day: "2026-08-19", requests: 2 }),
    row({ day: "2026-08-01", requests: 3 }),
    row({ day: "2026-07-01", requests: 5 }),
    // Grouped rollups carry null days; range math must ignore them.
    row({ day: null, requests: 100 })
  ];

  it("filters to the inclusive window and sums the metric", () => {
    const range = { from: "2026-08-01", to: "2026-08-19" };
    expect(rowsInRange(rows, range)).toHaveLength(2);
    expect(sumMetric(rowsInRange(rows, range), "requests")).toBe(5);
    expect(sumMetric(rowsInRange(rows, { from: null, to: "2026-08-19" }), "requests")).toBe(10);
  });
});

describe("deltaPercent", () => {
  it("is null without a positive baseline, signed percent otherwise", () => {
    expect(deltaPercent(5, 0)).toBeNull();
    expect(deltaPercent(150, 100)).toBe(50);
    expect(deltaPercent(0, 100)).toBe(-100);
    expect(formatDeltaPercent(50)).toBe("+50%");
    expect(formatDeltaPercent(-33.4)).toBe("-33%");
  });
});

describe("dailySeries", () => {
  it("zero-fills every day of a bounded range, summing same-day rows", () => {
    const rows = [
      row({ day: "2026-08-17", requests: 2 }),
      row({ day: "2026-08-17", requests: 3 }),
      row({ day: "2026-08-19", requests: 1 })
    ];
    const series = dailySeries(rows, { from: "2026-08-16", to: TODAY }, "requests");
    expect(series.map((point) => point.day)).toEqual([
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19"
    ]);
    expect(series.map((point) => point.value)).toEqual([0, 5, 0, 1]);
  });

  it("starts an unbounded range at the first recorded day", () => {
    const rows = [row({ day: "2026-08-17", requests: 1 })];
    const series = dailySeries(rows, { from: null, to: TODAY }, "requests");
    expect(series[0].day).toBe("2026-08-17");
    expect(series).toHaveLength(3);
  });

  it("collapses an empty unbounded range to a single zero day", () => {
    expect(dailySeries([], { from: null, to: TODAY }, "requests")).toEqual([
      { day: TODAY, value: 0 }
    ]);
  });

  it("series total always matches the summary sum (section consistency)", () => {
    const rows = [
      row({ day: "2026-08-19", spend_micro_usd: 3_000_000, requests: 2, input_tokens: 10 }),
      row({ day: "2026-08-05", spend_micro_usd: 1_500_000, requests: 5, output_tokens: 20 }),
      row({ day: "2026-06-01", spend_micro_usd: 9_000_000, requests: 9, input_tokens: 30 })
    ];
    for (const period of ["today", "7d", "30d", "1y", "all"] as const) {
      for (const metric of ["spend", "tokens", "requests"] as const) {
        const range = periodRange(period, TODAY);
        const fromSeries = dailySeries(rows, range, metric).reduce(
          (sum, point) => sum + point.value,
          0
        );
        expect(fromSeries).toBe(sumMetric(rowsInRange(rows, range), metric));
      }
    }
  });
});

describe("topGroups", () => {
  it("sorts by the chosen metric, drops zero groups, breaks ties by label", () => {
    const rows = [
      row({ alias: "gpt-5.6", requests: 5, spend_micro_usd: 100 }),
      row({ alias: "claude-opus-5", requests: 5, spend_micro_usd: 900 }),
      row({ alias: "idle-model", requests: 0 })
    ];
    expect(topGroups(rows, "spend", (r) => r.alias ?? "unknown", 5).map((g) => g.label)).toEqual([
      "claude-opus-5",
      "gpt-5.6"
    ]);
    // Equal requests: alphabetical, stable across renders.
    expect(topGroups(rows, "requests", (r) => r.alias ?? "unknown", 5).map((g) => g.label)).toEqual(
      ["claude-opus-5", "gpt-5.6"]
    );
  });

  it("merges rows sharing a label and honors the count cap", () => {
    const rows = [
      row({ alias: "a", requests: 1 }),
      row({ alias: "a", requests: 2 }),
      row({ alias: "b", requests: 2 })
    ];
    const top = topGroups(rows, "requests", (r) => r.alias ?? "unknown", 1);
    expect(top).toEqual([{ label: "a", value: 3 }]);
  });
});

describe("dailyModelStacks", () => {
  const range = { from: "2026-08-18", to: "2026-08-19" };
  const dayRows = [
    row({ day: "2026-08-18", requests: 3, input_tokens: 30, output_tokens: 15, spend_micro_usd: 600 }),
    row({ day: "2026-08-19", requests: 4, input_tokens: 40, output_tokens: 20, spend_micro_usd: 1_000 })
  ];
  const modelDayRows = [
    row({ day: "2026-08-18", alias: "gpt-5.6", requests: 2, input_tokens: 20, output_tokens: 10, spend_micro_usd: 100 }),
    row({ day: "2026-08-18", alias: "claude-opus-5", requests: 1, input_tokens: 10, output_tokens: 5, spend_micro_usd: 500 }),
    row({ day: "2026-08-19", alias: "claude-opus-5", requests: 4, input_tokens: 40, output_tokens: 20, spend_micro_usd: 1_000 })
  ];

  it("ranks named series by range spend and zero-fills the day axis", () => {
    const stacks = dailyModelStacks(dayRows, modelDayRows, range);
    expect(stacks.days).toEqual(["2026-08-18", "2026-08-19"]);
    // Spend-anchored order: claude ($0.0015) ahead of gpt ($0.0001); the
    // breakdown fully covers the totals, so no Other fold appears.
    expect(stacks.series.map((entry) => entry.key)).toEqual(["claude-opus-5", "gpt-5.6"]);
    expect(stacks.series[0].detail.map((cell) => cell.spend_micro_usd)).toEqual([500, 1_000]);
    expect(stacks.series[1].detail.map((cell) => cell.requests)).toEqual([2, 0]);
    expect(stacks.totals.map((cell) => cell.requests)).toEqual([3, 4]);
  });

  it("folds the tail past maxSeries into a per-day residual Other", () => {
    const stacks = dailyModelStacks(dayRows, modelDayRows, range, { maxSeries: 1 });
    expect(stacks.series.map((entry) => entry.key)).toEqual(["claude-opus-5", OTHER_SERIES_KEY]);
    const other = stacks.series[1];
    // Other = day total minus the named series, per metric: on the 18th the
    // gpt row (2 req / $0.0001) is the residual; on the 19th nothing is.
    expect(other.detail[0]).toEqual({
      requests: 2,
      input_tokens: 20,
      output_tokens: 10,
      spend_micro_usd: 100
    });
    expect(other.detail[1].requests).toBe(0);
  });

  it("absorbs a row-capped (incomplete) breakdown into Other instead of undercounting", () => {
    // The per-model read lost the 18th entirely (cap truncation): the day
    // totals still carry it, so the whole day renders as Other and every
    // stack still sums to the headline series.
    const truncated = [modelDayRows[2]];
    const stacks = dailyModelStacks(dayRows, truncated, range);
    const other = stacks.series.find((entry) => entry.key === OTHER_SERIES_KEY);
    expect(other?.detail[0].spend_micro_usd).toBe(600);
    expect(other?.detail[0].requests).toBe(3);
    for (const [index] of stacks.days.entries()) {
      const stackSum = stacks.series.reduce((sum, entry) => sum + entry.detail[index].spend_micro_usd, 0);
      expect(stackSum).toBe(stacks.totals[index].spend_micro_usd);
    }
  });

  it("ranks from the range rollup when given, so a capped per-day read cannot demote a model", () => {
    // The per-day read lost every claude cell to the row cap; the rollup
    // still knows claude dominates the range, so it stays a named series
    // (its missing cells render as Other via the residual) instead of the
    // surviving gpt cells stealing the top slot.
    const cappedCells = [modelDayRows[0]]; // gpt only
    const rankRows = [
      row({ alias: "claude-opus-5", spend_micro_usd: 10_000, requests: 5 }),
      row({ alias: "gpt-5.6", spend_micro_usd: 100, requests: 2 })
    ];
    const stacks = dailyModelStacks(dayRows, cappedCells, range, { rankRows, maxSeries: 1 });
    expect(stacks.series.map((entry) => entry.key)).toEqual([
      "claude-opus-5",
      OTHER_SERIES_KEY
    ]);
  });

  it("clamps a skewed snapshot at zero rather than rendering negative residuals", () => {
    // The per-model read raced ahead of the day read: named cells exceed the
    // day total; Other clamps to zero instead of going negative.
    const ahead = [
      row({ day: "2026-08-19", alias: "claude-opus-5", requests: 9, spend_micro_usd: 5_000 })
    ];
    const stacks = dailyModelStacks(dayRows, ahead, range);
    const other = stacks.series.find((entry) => entry.key === OTHER_SERIES_KEY);
    expect(other?.detail[1].spend_micro_usd).toBe(0);
  });

  it("collapses an empty org to the bare right edge with no series", () => {
    const stacks = dailyModelStacks([], [], { from: null, to: "2026-08-19" });
    expect(stacks.days).toEqual(["2026-08-19"]);
    expect(stacks.series).toEqual([]);
  });
});

describe("activityStats", () => {
  it("computes streak over consecutive active days plus averages", () => {
    const series = [
      { day: "2026-08-13", value: 1 },
      { day: "2026-08-14", value: 2 },
      { day: "2026-08-15", value: 0 },
      { day: "2026-08-16", value: 3 },
      { day: "2026-08-17", value: 4 },
      { day: "2026-08-18", value: 5 },
      { day: "2026-08-19", value: 0 }
    ];
    const stats = activityStats(series);
    expect(stats.longestStreakDays).toBe(3);
    expect(stats.total).toBe(15);
    expect(stats.averagePerDay).toBeCloseTo(15 / 7);
    expect(stats.averagePerWeek).toBeCloseTo(15);
  });

  it("handles an empty window", () => {
    expect(activityStats([])).toEqual({
      longestStreakDays: 0,
      averagePerDay: 0,
      averagePerWeek: 0,
      total: 0
    });
  });
});
