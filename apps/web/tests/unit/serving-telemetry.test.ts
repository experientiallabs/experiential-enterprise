import { formatRequestCostUsd } from "@/lib/money";
import { describe, expect, it } from "vitest";

import { logsPath } from "@/lib/routes";
import { fillServingBuckets, formatLatencyMs, servingRequestQueryFromSearchParams, servingRequestQueryString } from "@/lib/serving-telemetry";

describe("servingRequestQueryString", () => {
  it("serializes filters, cursor, and limit", () => {
    const qs = servingRequestQueryString({
      endpoint: "endpoint-1",
      status: "error",
      window: "24h",
      cursor: { ts: "2026-07-23T10:00:00+00:00", id: "request-9", after: "2026-07-16T10:00:00+00:00" },
      limit: 50
    });
    const params = new URLSearchParams(qs);
    expect(params.get("endpoint")).toBe("endpoint-1");
    expect(params.get("status")).toBe("error");
    expect(params.get("window")).toBe("24h");
    expect(params.get("cursor_ts")).toBe("2026-07-23T10:00:00+00:00");
    expect(params.get("cursor_id")).toBe("request-9");
    expect(params.get("cursor_after")).toBe("2026-07-16T10:00:00+00:00");
    expect(params.get("limit")).toBe("50");
  });

  it("round-trips through the proxy-route parser", () => {
    const query = {
      endpoint: "endpoint-1",
      status: "error" as const,
      window: "30d" as const,
      cursor: { ts: "2026-07-23T10:00:00+00:00", id: "request-9", after: "2026-07-16T10:00:00+00:00" },
      limit: 25
    };
    const parsed = servingRequestQueryFromSearchParams(
      new URLSearchParams(servingRequestQueryString(query))
    );
    expect(parsed).toEqual(query);
  });

  it("drops invalid windows, statuses, and half cursors", () => {
    const parsed = servingRequestQueryFromSearchParams(
      new URLSearchParams("window=90d&status=meh&cursor_ts=2026-07-23&limit=abc")
    );
    expect(parsed).toEqual({});
  });
});

describe("logsPath", () => {
  it("builds the plain path (the page's own URL sync carries the filters)", () => {
    expect(logsPath()).toBe("/logs");
  });
});

describe("fillServingBuckets", () => {
  it("expands sparse buckets to a contiguous window", () => {
    const now = Date.parse("2026-07-23T12:30:00Z");
    const filled = fillServingBuckets(
      [{ bucket_start: "2026-07-22T00:00:00.000Z", request_count: 4, error_count: 1 }],
      86_400,
      "7d",
      now
    );
    expect(filled).toHaveLength(8);
    expect(filled.filter((bucket) => bucket.request_count > 0)).toHaveLength(1);
    expect(filled.at(-1)?.bucket_start).toBe("2026-07-23T00:00:00.000Z");
  });
});

describe("formatters", () => {
  it("keeps sub-cent request costs readable", () => {
    expect(formatRequestCostUsd(null)).toBe("—");
    expect(formatRequestCostUsd(0)).toBe("$0.00");
    expect(formatRequestCostUsd(0.003)).toBe("$0.003");
    expect(formatRequestCostUsd(0.0412)).toBe("$0.041");
    expect(formatRequestCostUsd(12.4)).toBe("$12.40");
    expect(formatRequestCostUsd(4e-7)).toBe("<$0.000001");
    expect(formatRequestCostUsd(Number.NaN)).toBe("—");
    expect(formatRequestCostUsd(-1)).toBe("—");
  });

  it("switches latency to seconds above one second", () => {
    expect(formatLatencyMs(null)).toBe("—");
    expect(formatLatencyMs(310)).toBe("310ms");
    expect(formatLatencyMs(999.6)).toBe("1.0s");
    expect(formatLatencyMs(1900)).toBe("1.9s");
    expect(formatLatencyMs(12_000)).toBe("12s");
    expect(formatLatencyMs(Number.NaN)).toBe("—");
  });
});
