import { describe, expect, it } from "vitest";

import {
  blendedPerMillionUsd,
  modelUsageSeries,
  providerRows,
  topKeysBySpend,
  topModelsBySpend
} from "@/lib/activity-usage";
import type { KeyUsage, ProviderUsage, UsageBucket } from "@/lib/types";

// All buckets land on one aligned slot so the fixtures are position-free: the
// window's last bucket start for a day-bucketed 7d window at this clock.
const NOW_MS = Date.parse("2026-08-22T12:00:00Z");
const SLOT = "2026-08-22T00:00:00.000Z";
const BUCKET_SECONDS = 86_400;

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    bucket_start: SLOT,
    model: "gpt-5.6",
    lane: "platform",
    request_count: 1,
    error_count: 0,
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 1,
    estimated_cost_usd: 0,
    ...overrides
  };
}

function key(overrides: Partial<KeyUsage>): KeyUsage {
  return {
    api_key_id: "k1",
    key_label: "prod",
    models: [],
    totals: {
      request_count: 10,
      error_count: 0,
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 5,
      estimated_cost_usd: 0
    },
    last_used_at: SLOT,
    ...overrides
  };
}

function provider(overrides: Partial<ProviderUsage>): ProviderUsage {
  return {
    provider: "openai",
    request_count: 4,
    error_count: 0,
    input_tokens: 400,
    output_tokens: 200,
    cost_usd: 2,
    estimated_cost_usd: 0,
    last_used_at: SLOT,
    ...overrides
  };
}

describe("modelUsageSeries", () => {
  it("folds the tail past six models into an Other band and conserves the total", () => {
    const buckets = Array.from({ length: 8 }, (_, i) =>
      bucket({ model: `m${i}`, cost_usd: 8 - i, request_count: 8 - i })
    );
    const series = modelUsageSeries(buckets, BUCKET_SECONDS, "7d", NOW_MS, "spend");
    // Six named bands plus one folded "Other".
    expect(series.series).toHaveLength(7);
    expect(series.series[series.series.length - 1].label).toBe("Other");
    // The stack conserves the window's total spend (36 = 8+7+...+1).
    const total = series.series.reduce(
      (sum, entry) => sum + entry.points.reduce((s, v) => s + v, 0),
      0
    );
    expect(total).toBe(36);
  });

  it("plots the requests metric on the same model order", () => {
    const buckets = [
      bucket({ model: "a", cost_usd: 1, request_count: 2 }),
      bucket({ model: "b", cost_usd: 9, request_count: 3 })
    ];
    const series = modelUsageSeries(buckets, BUCKET_SECONDS, "7d", NOW_MS, "requests");
    // b outspends a, so it leads the series order in every metric.
    expect(series.series.map((entry) => entry.key)).toEqual(["b", "a"]);
    const total = series.series.reduce(
      (sum, entry) => sum + entry.points.reduce((s, v) => s + v, 0),
      0
    );
    expect(total).toBe(5);
  });
});

describe("topModelsBySpend", () => {
  it("ranks by all-spend with the leader at full width", () => {
    const rows = topModelsBySpend(
      [
        bucket({ model: "cheap", cost_usd: 1, request_count: 4 }),
        bucket({ model: "pricey", cost_usd: 9, estimated_cost_usd: 1, request_count: 2 })
      ],
      5
    );
    expect(rows.map((row) => row.label)).toEqual(["pricey", "cheap"]);
    expect(rows[0].value).toBe(10);
    expect(rows[0].fraction).toBe(1);
    expect(rows[0].detail).toContain("2");
  });

  it("drops models with no spend", () => {
    expect(topModelsBySpend([bucket({ model: "free", cost_usd: 0, estimated_cost_usd: 0 })], 5)).toEqual([]);
  });
});

describe("topKeysBySpend", () => {
  it("ranks keys by all-spend and names deleted keys honestly", () => {
    const rows = topKeysBySpend(
      [
        key({ api_key_id: "k1", key_label: "prod", totals: { ...key({}).totals, cost_usd: 2 } }),
        key({ api_key_id: "k2", key_label: "ci", totals: { ...key({}).totals, cost_usd: 8 } }),
        key({ api_key_id: null, key_label: null, totals: { ...key({}).totals, cost_usd: 1 } })
      ],
      5
    );
    expect(rows[0].label).toBe("ci");
    expect(rows[0].fraction).toBe(1);
    expect(rows.some((row) => row.label === "(deleted key)")).toBe(true);
  });
});

describe("providerRows", () => {
  it("ranks providers and keys each row on its provider enum for the logo", () => {
    const rows = providerRows(
      [
        provider({ provider: "openai", cost_usd: 3 }),
        provider({ provider: "anthropic", cost_usd: 7 }),
        provider({ provider: null, cost_usd: 0, request_count: 2, estimated_cost_usd: 0 })
      ],
      5
    );
    expect(rows[0].key).toBe("anthropic");
    expect(rows.find((row) => row.key === "undispatched")?.label).toBe("(undispatched)");
  });
});

describe("blendedPerMillionUsd", () => {
  it("scales all-spend over tokens to a million, and is null on no tokens", () => {
    expect(blendedPerMillionUsd(10, 2_000_000)).toBe(5);
    expect(blendedPerMillionUsd(5, 0)).toBeNull();
  });
});
