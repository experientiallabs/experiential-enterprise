import { describe, expect, it } from "vitest";

import {
  buildJobStatusTone,
  formatBytes,
  gatewayRequestOutcomeReason,
  worldModelStatusTone
} from "@/lib/format";

describe("gatewayRequestOutcomeReason", () => {
  it("prefers the sanitized upstream message on a failure", () => {
    expect(gatewayRequestOutcomeReason("failed", "provider 529 overloaded")).toBe(
      "provider 529 overloaded"
    );
  });

  it("explains the terminal state when no message was recorded", () => {
    // WMO exposes no finer finish reason than the status, so an incomplete row
    // still gets a human explanation rather than a bare "Incomplete".
    expect(gatewayRequestOutcomeReason("incomplete", null)).toMatch(/ended before completion/);
    expect(gatewayRequestOutcomeReason("expired_before_dispatch", "")).toMatch(/expired/);
  });

  it("has no reason to show for a completed request", () => {
    expect(gatewayRequestOutcomeReason("completed", null)).toBeNull();
  });
});

describe("status tones", () => {
  it("renders ready world models with the success tone", () => {
    expect(worldModelStatusTone("ready")).toBe("passed");
    expect(worldModelStatusTone("building")).toBe("running");
    expect(worldModelStatusTone("failed")).toBe("failed");
  });

  it("renders completed builds with the neutral completion tone", () => {
    expect(buildJobStatusTone("completed")).toBe("complete");
    expect(buildJobStatusTone("claimed")).toBe("running");
  });
});

describe("formatBytes", () => {
  it("scales through B, KB, and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
