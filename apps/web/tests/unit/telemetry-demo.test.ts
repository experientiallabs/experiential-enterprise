import { describe, expect, it } from "vitest";

import { fillBucketStarts } from "@/lib/gateway-telemetry";
import {
  DEMO_AGENTS,
  EXAMPLE_SUGGESTIONS,
  demoByKey,
  demoRequests,
  demoTimeseries
} from "@/lib/telemetry-demo";

// Frozen clock: the dataset must be a pure function of (query, nowMs).
const NOW_MS = Date.parse("2026-08-18T15:30:00Z");

describe("telemetry demo dataset", () => {
  it("is deterministic for a given clock", () => {
    expect(demoTimeseries({ window: "7d" }, NOW_MS)).toEqual(
      demoTimeseries({ window: "7d" }, NOW_MS)
    );
    expect(demoRequests({ window: "7d" }, NOW_MS)).toEqual(demoRequests({ window: "7d" }, NOW_MS));
  });

  it("covers the 7d window with daily buckets on the real grid, both lanes split correctly", () => {
    const timeseries = demoTimeseries({ window: "7d" }, NOW_MS);
    expect(timeseries.window).toBe("7d");
    expect(timeseries.bucket_seconds).toBe(86_400);
    const grid = new Set(
      fillBucketStarts(86_400, "7d", NOW_MS).map((at) => new Date(at).toISOString())
    );
    for (const bucket of timeseries.buckets) {
      expect(grid.has(bucket.bucket_start)).toBe(true);
    }
    const models = new Set(timeseries.buckets.map((bucket) => bucket.model));
    expect(models.size).toBe(5);
    const lanes = new Set(timeseries.buckets.map((bucket) => bucket.lane));
    expect(lanes).toEqual(new Set(["platform", "byok"]));
    for (const bucket of timeseries.buckets) {
      // The money split is the product invariant: platform traffic charges
      // credits, BYOK traffic carries a never-charged estimate — never both.
      if (bucket.lane === "platform") {
        expect(bucket.cost_usd).toBeGreaterThan(0);
        expect(bucket.estimated_cost_usd).toBe(0);
      } else {
        expect(bucket.estimated_cost_usd).toBeGreaterThan(0);
        expect(bucket.cost_usd).toBe(0);
      }
      expect(bucket.request_count).toBeGreaterThan(0);
      expect(bucket.error_count).toBeLessThanOrEqual(bucket.request_count);
    }
  });

  it("buckets hourly for 24h so the short window never renders empty", () => {
    const timeseries = demoTimeseries({ window: "24h" }, NOW_MS);
    expect(timeseries.bucket_seconds).toBe(3_600);
    expect(timeseries.buckets.length).toBeGreaterThan(24);
  });

  it("composes filters like the real endpoints", () => {
    const modelOnly = demoTimeseries({ window: "7d", model: "claude-sonnet-5" }, NOW_MS);
    expect(new Set(modelOnly.buckets.map((bucket) => bucket.model))).toEqual(
      new Set(["claude-sonnet-5"])
    );
    const byokOnly = demoTimeseries({ window: "7d", lane: "byok" }, NOW_MS);
    expect(byokOnly.buckets.every((bucket) => bucket.lane === "byok")).toBe(true);
    // prod-agent sends no claude-haiku-4-5 traffic, so the agent filter
    // removes that model entirely.
    const agentOnly = demoTimeseries({ window: "7d", apiKeyId: DEMO_AGENTS[0].id }, NOW_MS);
    expect(agentOnly.buckets.length).toBeGreaterThan(0);
    expect(agentOnly.buckets.some((bucket) => bucket.model === "claude-haiku-4-5")).toBe(false);

    const errorsOnly = demoRequests({ window: "7d", status: "error" }, NOW_MS);
    expect(errorsOnly.requests.length).toBeGreaterThan(0);
    expect(errorsOnly.requests.every((row) => row.status !== "completed")).toBe(true);
    const agentRequests = demoRequests({ window: "7d", apiKeyId: DEMO_AGENTS[2].id }, NOW_MS);
    expect(agentRequests.requests.every((row) => row.key_label === "cli")).toBe(true);
  });

  it("splits the by-key rollup so agents sum exactly to the timeseries totals", () => {
    const byKey = demoByKey("7d", NOW_MS);
    expect(byKey.keys.map((key) => key.key_label)).toEqual(["prod-agent", "staging", "cli"]);
    const timeseries = demoTimeseries({ window: "7d" }, NOW_MS);
    const totalsByModel = new Map<string, number>();
    for (const bucket of timeseries.buckets) {
      totalsByModel.set(
        bucket.model,
        (totalsByModel.get(bucket.model) ?? 0) + bucket.request_count
      );
    }
    const splitByModel = new Map<string, number>();
    for (const key of byKey.keys) {
      for (const usage of key.models) {
        splitByModel.set(usage.model, (splitByModel.get(usage.model) ?? 0) + usage.request_count);
      }
    }
    expect(splitByModel).toEqual(totalsByModel);
  });

  it("returns one page of request rows, cursor-free", () => {
    const page = demoRequests({ window: "7d", limit: 50 }, NOW_MS);
    expect(page.requests.length).toBeGreaterThan(10);
    expect(page.requests.length).toBeLessThanOrEqual(50);
    expect(page.next_cursor).toBeNull();
    // Newest first, all inside the shortest window so every filter view has rows.
    const times = page.requests.map((row) => Date.parse(row.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(Math.min(...times)).toBeGreaterThan(NOW_MS - 24 * 3_600_000);
  });

  it("ships exactly two example suggestions in the contract shape", () => {
    expect(EXAMPLE_SUGGESTIONS).toHaveLength(2);
    for (const suggestion of EXAMPLE_SUGGESTIONS) {
      expect(suggestion.id.startsWith("example:")).toBe(true);
      expect(suggestion.evidence.length).toBeGreaterThan(0);
      expect(suggestion.evidence[0]).toMatch(/Example/);
    }
  });
});
