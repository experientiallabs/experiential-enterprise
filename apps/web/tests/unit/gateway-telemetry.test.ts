import { describe, expect, it } from "vitest";

import {
  agentLabel,
  allSpendUsd,
  DEFAULT_TELEMETRY_VIEW,
  displayModel,
  laneLabel,
  laneSpendSeries,
  latencyPercentiles,
  modelOptions,
  modelRollups,
  modelSpendSeries,
  parseTelemetryView,
  telemetryViewQueryString,
  topToolsUsed,
  usageRequestsQueryFromSearchParams,
  usageRequestsQueryFromView,
  usageRequestsQueryString,
  usageTotals
} from "@/lib/gateway-telemetry";
import type { UsageBucket, UsageRequestItem } from "@/lib/types";

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    bucket_start: "2026-08-18T00:00:00+00:00",
    model: "gpt-5",
    lane: "platform",
    request_count: 10,
    error_count: 1,
    input_tokens: 1000,
    output_tokens: 200,
    cost_usd: 0.5,
    estimated_cost_usd: 0,
    ...overrides
  };
}

function requestItem(overrides: Partial<UsageRequestItem>): UsageRequestItem {
  return {
    request_id: "req-1",
    model: "gpt-5",
    provider: "openai",
    lane: "platform",
    api_key_id: "key-1",
    key_label: "prod-agent",
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0.01,
    estimated_cost_usd: 0,
    real_cost_usd: 0.01,
    pricing_known: true,
    latency_ms: 300,
    ttft_ms: 120,
    status: "completed",
    attempt_count: 1,
    created_at: "2026-08-18T10:00:00+00:00",
    tools_used: [],
    failure_class: null,
    error_message: null,
    prompt_group: null,
    conversation_group: null,
    ...overrides
  };
}

describe("telemetry view state", () => {
  it("parses the deep-link params and defaults the rest", () => {
    expect(
      parseTelemetryView({
        window: "24h",
        model: "gpt-5",
        agent: "aaaa0000-0000-4000-8000-000000000001",
        lane: "byok",
        status: "error",
        live: "1"
      })
    ).toEqual({
      window: "24h",
      model: "gpt-5",
      agentId: "aaaa0000-0000-4000-8000-000000000001",
      lane: "byok",
      errorsOnly: true,
      live: true
    });
    expect(parseTelemetryView({})).toEqual(DEFAULT_TELEMETRY_VIEW);
    expect(parseTelemetryView({ window: "90d" }).window).toBe("7d");
    expect(parseTelemetryView({ lane: "credit" }).lane).toBeNull();
  });

  it("writes only non-default values, auto-refresh included", () => {
    expect(telemetryViewQueryString(DEFAULT_TELEMETRY_VIEW)).toBe("");
    const qs = telemetryViewQueryString({
      window: "24h",
      model: "gpt-5",
      agentId: "key-1",
      lane: "platform",
      errorsOnly: true,
      live: true
    });
    const params = new URLSearchParams(qs);
    expect(params.get("window")).toBe("24h");
    expect(params.get("model")).toBe("gpt-5");
    expect(params.get("agent")).toBe("key-1");
    expect(params.get("lane")).toBe("platform");
    expect(params.get("status")).toBe("error");
    expect(params.get("live")).toBe("1");
  });

  it("round-trips the view through the request-log query and proxy parser", () => {
    const query = usageRequestsQueryFromView(
      {
        window: "30d",
        model: "gpt-5",
        agentId: "key-1",
        lane: "byok",
        errorsOnly: true,
        live: false
      },
      { ts: "2026-08-18T10:00:00+00:00", id: "req-9", after: "2026-07-19T10:00:00+00:00" }
    );
    const parsed = usageRequestsQueryFromSearchParams(
      new URLSearchParams(usageRequestsQueryString(query))
    );
    expect(parsed).toEqual(query);
  });

  it("drops invalid windows, lanes, statuses, and half cursors", () => {
    const parsed = usageRequestsQueryFromSearchParams(
      new URLSearchParams("window=90d&lane=cash&status=meh&cursor_ts=2026-08-18&limit=abc")
    );
    expect(parsed).toEqual({});
  });
});

describe("aggregation", () => {
  const BUCKETS: UsageBucket[] = [
    bucket({}),
    bucket({
      bucket_start: "2026-08-17T00:00:00+00:00",
      model: "claude-fable-5",
      lane: "byok",
      request_count: 4,
      error_count: 0,
      input_tokens: 400,
      output_tokens: 100,
      cost_usd: 0,
      estimated_cost_usd: 2.25
    }),
    bucket({
      model: "",
      lane: null,
      request_count: 2,
      error_count: 2,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      estimated_cost_usd: 0
    })
  ];

  it("totals every cell and keeps the money split", () => {
    const totals = usageTotals(BUCKETS);
    expect(totals.requestCount).toBe(16);
    expect(totals.errorCount).toBe(3);
    expect(totals.inputTokens).toBe(1400);
    expect(totals.costUsd).toBeCloseTo(0.5);
    expect(totals.estimatedCostUsd).toBeCloseTo(2.25);
    expect(allSpendUsd(totals)).toBeCloseTo(2.75);
  });

  it("rolls up per model, biggest all-spend first", () => {
    const rollups = modelRollups(BUCKETS);
    expect(rollups.map((rollup) => rollup.model)).toEqual(["claude-fable-5", "gpt-5", ""]);
    expect(rollups[0].estimatedCostUsd).toBeCloseTo(2.25);
    expect(rollups[2].requestCount).toBe(2);
  });

  it("splits spend per lane over a contiguous filled axis", () => {
    const nowMs = Date.parse("2026-08-18T12:30:00Z");
    const { starts, series } = laneSpendSeries(BUCKETS, 86_400, "7d", nowMs);
    expect(starts).toHaveLength(8);
    const platform = series.find((entry) => entry.key === "platform")!;
    const byok = series.find((entry) => entry.key === "byok")!;
    expect(platform.points.reduce((a, b) => a + b, 0)).toBeCloseTo(0.5);
    expect(byok.points.reduce((a, b) => a + b, 0)).toBeCloseTo(2.25);
    // The undispatched cell carries no dollars and lands in neither lane.
    expect(platform.points).toHaveLength(8);
  });

  it("caps the per-model series and aggregates the tail as Other", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      bucket({ model: `model-${index}`, cost_usd: 7 - index })
    );
    const nowMs = Date.parse("2026-08-18T12:30:00Z");
    const { series } = modelSpendSeries(many, 86_400, "7d", nowMs);
    expect(series).toHaveLength(6);
    expect(series.at(-1)?.label).toBe("Other");
    const total = series.flatMap((entry) => entry.points).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(7 + 6 + 5 + 4 + 3 + 2 + 1);
  });

  it("derives nearest-rank latency percentiles and skips untimed rows", () => {
    const requests = [
      requestItem({ latency_ms: 100 }),
      requestItem({ latency_ms: 200 }),
      requestItem({ latency_ms: 300 }),
      requestItem({ latency_ms: null })
    ];
    expect(latencyPercentiles(requests)).toEqual({ p50: 200, p95: 300, sample: 3 });
    expect(latencyPercentiles([requestItem({ latency_ms: null })])).toBeNull();
  });

  it("unions model options from buckets and key rollups", () => {
    const options = modelOptions(BUCKETS, [
      {
        api_key_id: "key-1",
        key_label: "prod-agent",
        models: [
          {
            model: "gemini-3-pro",
            request_count: 1,
            error_count: 0,
            input_tokens: 10,
            output_tokens: 5,
            cost_usd: 0.01,
            estimated_cost_usd: 0
          }
        ],
        totals: {
          request_count: 1,
          error_count: 0,
          input_tokens: 10,
          output_tokens: 5,
          cost_usd: 0.01,
          estimated_cost_usd: 0
        },
        last_used_at: "2026-08-18T10:00:00+00:00"
      }
    ]);
    expect(options).toEqual(["claude-fable-5", "gpt-5", "", "gemini-3-pro"]);
  });
});

describe("ledger display naming", () => {
  it("names the null cases exactly", () => {
    expect(displayModel("")).toBe("(unattributed)");
    expect(displayModel("gpt-5")).toBe("gpt-5");
    expect(laneLabel(null)).toBe("(undispatched)");
    expect(laneLabel("platform")).toBe("Platform");
    expect(laneLabel("byok")).toBe("BYOK");
    // Hard-deleted before settlement: no id at all.
    expect(agentLabel(null, null)).toBe("(deleted key)");
    // Deleted after settlement: attribution survives as the id snapshot.
    expect(agentLabel("aaaa0000-0000-4000-8000-000000000001", null)).toBe("aaaa0000 (deleted)");
    expect(agentLabel("aaaa0000-0000-4000-8000-000000000001", "prod-agent")).toBe("prod-agent");
  });
});

describe("topToolsUsed", () => {
  it("ranks tools by the number of requests that used them, ties by name", () => {
    const requests = [
      requestItem({ request_id: "r1", tools_used: ["web_search", "fetch_url"] }),
      requestItem({ request_id: "r2", tools_used: ["web_search"] }),
      requestItem({ request_id: "r3", tools_used: ["fetch_url", "run_python"] })
    ];
    expect(topToolsUsed(requests, 10)).toEqual([
      { name: "fetch_url", count: 2 },
      { name: "web_search", count: 2 },
      { name: "run_python", count: 1 }
    ]);
  });

  it("caps to the requested limit", () => {
    const requests = [requestItem({ tools_used: ["a", "b", "c"] })];
    expect(topToolsUsed(requests, 2)).toHaveLength(2);
  });

  it("returns an empty list when no request captured a tool (the current state)", () => {
    const requests = [requestItem({ tools_used: [] }), requestItem({ tools_used: [] })];
    expect(topToolsUsed(requests, 10)).toEqual([]);
  });
});
