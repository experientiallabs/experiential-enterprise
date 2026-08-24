import { describe, expect, it } from "vitest";

import {
  isEstimatedPricing,
  isEstimatedStats,
  isMeasuredStats,
  statsSourceLabel
} from "@/lib/models-catalog/provenance";
import { makeDeployment } from "./models-catalog-fixtures";

describe("metadata provenance", () => {
  it("flags an explicitly estimated price", () => {
    expect(isEstimatedPricing(makeDeployment({ pricing_source: "estimate" }))).toBe(true);
    expect(isEstimatedPricing(makeDeployment({ pricing_source: "openrouter" }))).toBe(false);
    expect(isEstimatedPricing(makeDeployment({ pricing_source: null }))).toBe(false);
  });

  it("treats observed stats as measured and everything else as estimated", () => {
    const measured = makeDeployment({ stats_source: "observed" });
    const seeded = makeDeployment({ stats_source: "openrouter" });
    const unknown = makeDeployment({ stats_source: null });
    expect(isMeasuredStats(measured)).toBe(true);
    expect(isEstimatedStats(measured)).toBe(false);
    expect(isMeasuredStats(seeded)).toBe(false);
    expect(isEstimatedStats(seeded)).toBe(true);
    // Unknown is neither measured nor an estimate — it renders as no data.
    expect(isMeasuredStats(unknown)).toBe(false);
    expect(isEstimatedStats(unknown)).toBe(false);
  });

  it("treats a seeded 'estimate' stat as estimated, not measured", () => {
    const est = makeDeployment({ stats_source: "estimate" });
    expect(isMeasuredStats(est)).toBe(false);
    expect(isEstimatedStats(est)).toBe(true);
  });

  it("labels the stats source for the UI, null when unknown", () => {
    expect(statsSourceLabel(makeDeployment({ stats_source: "observed" }))).toMatch(/Measured/);
    expect(statsSourceLabel(makeDeployment({ stats_source: "openrouter" }))).toMatch(/Estimated/);
    expect(statsSourceLabel(makeDeployment({ stats_source: "estimate" }))).toMatch(/Estimated/);
    expect(statsSourceLabel(makeDeployment({ stats_source: null }))).toBeNull();
  });
});
