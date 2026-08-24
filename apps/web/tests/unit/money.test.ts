import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FRONTIER_MODEL_LABEL,
  FRONTIER_USD_PER_MTOK,
  dollarFormatter,
  formatCostUsd,
  formatGrantUsd,
  formatPerCallUsd,
  formatRequestCostUsd,
  formatRunSpendUsd,
  formatSignedCostUsd
} from "@/lib/money";

describe("money formatters", () => {
  it("never renders priced spend as free", () => {
    expect(formatCostUsd(0.004)).toBe("<$0.01");
    expect(formatRunSpendUsd(0.004)).toBe("<$0.01");
    expect(formatRequestCostUsd(0.0000004)).toBe("<$0.000001");
    expect(formatPerCallUsd(0.00004)).toBe("<$0.0001");
    expect(formatPerCallUsd(0)).toBe("$0.0000");
  });

  it("never renders an absent figure as zero", () => {
    expect(formatCostUsd(null)).toBe("—");
    expect(formatCostUsd(undefined)).toBe("—");
    expect(formatSignedCostUsd(undefined)).toBe("—");
    expect(formatRunSpendUsd(null)).toBe("not reported");
    expect(formatPerCallUsd(null)).toBe("unpriced");
  });

  it("keeps signed balances honest instead of clamping", () => {
    expect(formatSignedCostUsd(-5)).toBe("-$5.00");
    expect(formatSignedCostUsd(7.5)).toBe("$7.50");
  });

  it("rounds half-cent doubles in decimal, not binary", () => {
    expect(formatCostUsd(0.015)).toBe("$0.02");
  });

  it("drops the cents from a round-dollar grant, keeps them otherwise", () => {
    expect(formatGrantUsd(20)).toBe("$20");
    expect(formatGrantUsd(1500)).toBe("$1,500");
    expect(formatGrantUsd(25.5)).toBe("$25.50");
  });

  it("keeps a figure set in one precision so the figures visibly subtract", () => {
    const money = dollarFormatter([12.5, 593.55, 181.05]);
    expect(money(593.55)).toBe("$593.55");
    const whole = dollarFormatter([1200, 5930, 1810]);
    expect(whole(5930)).toBe("$5,930");
  });
});

describe("frontier anchor", () => {
  it("equals the Python source of truth, read from its file", () => {
    // The backend's explabs/frontier_pricing.py is the anchor's source of
    // truth; this reads the actual constants out of that file, so the client
    // mirror cannot drift while both suites pass.
    const source = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../../../explabs/frontier_pricing.py"),
      "utf8"
    );
    const constant = (name: string): number => {
      const match = source.match(new RegExp(`^${name} = ([0-9.]+)$`, "m"));
      if (!match) {
        throw new Error(`frontier_pricing.py no longer defines ${name}`);
      }
      return Number(match[1]);
    };
    const label = source.match(/^FRONTIER_MODEL_LABEL = "(.+)"$/m);

    expect(label?.[1]).toBe(FRONTIER_MODEL_LABEL);
    expect(FRONTIER_USD_PER_MTOK).toEqual({
      input: constant("INPUT_USD_PER_MTOK"),
      cachedInput: constant("CACHED_INPUT_USD_PER_MTOK"),
      output: constant("OUTPUT_USD_PER_MTOK")
    });
  });
});
