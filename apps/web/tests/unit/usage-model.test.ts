import { formatCostUsd } from "@/lib/money";
import { describe, expect, it } from "vitest";

import { formatTokensCompact, formatTokensInOut } from "@/components/playground/usage-model";

describe("formatTokensCompact", () => {
  it("keeps sub-thousand counts exact", () => {
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(950)).toBe("950");
  });

  it("abbreviates thousands with one decimal below three digits", () => {
    expect(formatTokensCompact(1_000)).toBe("1k");
    expect(formatTokensCompact(12_345)).toBe("12.3k");
    expect(formatTokensCompact(50_000)).toBe("50k");
    expect(formatTokensCompact(250_000)).toBe("250k");
  });

  it("abbreviates millions", () => {
    expect(formatTokensCompact(1_234_567)).toBe("1.2M");
    expect(formatTokensCompact(120_000_000)).toBe("120M");
  });

  it("promotes the unit at the rounding boundary instead of showing 1000k", () => {
    expect(formatTokensCompact(999_499)).toBe("999k");
    expect(formatTokensCompact(999_950)).toBe("1M");
  });

  it("renders unknown counts as an em dash", () => {
    expect(formatTokensCompact(undefined)).toBe("—");
  });
});

describe("formatTokensInOut", () => {
  it("pairs the abbreviated counts", () => {
    expect(formatTokensInOut(50_000, 250_000)).toBe("50k/250k");
  });

  it("dashes each unknown side independently", () => {
    expect(formatTokensInOut(undefined, 42)).toBe("—/42");
  });
});

describe("formatCostUsd", () => {
  it("dashes null and undefined alike", () => {
    expect(formatCostUsd(null)).toBe("—");
    expect(formatCostUsd(undefined)).toBe("—");
  });

  it("rounds to whole cents, never fractional-cent digits", () => {
    expect(formatCostUsd(0.1234)).toBe("$0.12");
    expect(formatCostUsd(0.005)).toBe("$0.01");
    expect(formatCostUsd(12.345)).toBe("$12.35");
  });

  it("flags priced sub-half-cent spend instead of showing it as free", () => {
    expect(formatCostUsd(0.001)).toBe("<$0.01");
    expect(formatCostUsd(0)).toBe("$0.00");
  });

  it("rounds decimal half-cents up despite binary float representation", () => {
    // 5,000 tokens at $3/M is exactly 1.5¢, but the double sits just below
    // 0.015 and bare toFixed(2) would show $0.01.
    expect(formatCostUsd(0.015)).toBe("$0.02");
    expect(formatCostUsd(1.005)).toBe("$1.01");
  });
});
