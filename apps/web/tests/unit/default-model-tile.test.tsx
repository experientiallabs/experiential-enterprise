import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TileMetrics,
  isBaselineHeadline,
  type TileHeadline
} from "@/components/models/default-model-tile";

const OPTIMIZED: TileHeadline = {
  accuracy: 0.928,
  baseline_accuracy: 0.916,
  savings_fraction: 0.56,
  latency_savings_fraction: 0.51
};

// A before-optimization report DECLARES itself (baseline_only); the UI never
// infers the state from zero deltas (the product owner, 2026-07-30: an optimizer run
// landing exactly on the baseline is a measurement, not an unoptimized state).
const BASELINE: TileHeadline = {
  accuracy: 0.916,
  baseline_accuracy: 0.916,
  savings_fraction: 0,
  latency_savings_fraction: 0,
  baseline_only: true
};

describe("TileMetrics", () => {
  it("renders the measured deltas for an optimized headline", () => {
    render(<TileMetrics headline={OPTIMIZED} />);
    expect(screen.getByText("+1.2%")).toBeInTheDocument();
    expect(screen.getByText("56%")).toBeInTheDocument();
    expect(screen.getByText("51%")).toBeInTheDocument();
  });

  it("says not-optimized-yet instead of three zero rows for a baseline report", () => {
    // The auto-provisioned endpoint's "before optimization" report has every
    // delta at a true zero; a card of 0% rows reads as broken, not measured.
    render(<TileMetrics headline={BASELINE} />);
    expect(screen.getByText(/not optimized yet/)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("+0.0%")).not.toBeInTheDocument();
  });

  it("classifies by the report's declared provenance, never by zero deltas", () => {
    expect(isBaselineHeadline(BASELINE)).toBe(true);
    expect(isBaselineHeadline(OPTIMIZED)).toBe(false);
    // An optimizer-written report with all-zero deltas is a MEASUREMENT: no
    // flag, no baseline note (the product owner, 2026-07-30: never after an optimizer run).
    expect(
      isBaselineHeadline({ ...BASELINE, baseline_only: undefined })
    ).toBe(false);
  });

  it("renders all-zero optimizer results as measured rows, not the baseline note", () => {
    render(<TileMetrics headline={{ ...BASELINE, baseline_only: undefined }} />);
    expect(screen.queryByText(/not optimized yet/)).not.toBeInTheDocument();
    expect(screen.getByText("+0.0%")).toBeInTheDocument();
  });
});
