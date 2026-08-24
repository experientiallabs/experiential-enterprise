import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ImportedSpendSection } from "@/components/telemetry-page/imported-spend";
import { formatCostUsd } from "@/lib/money";
import type { ImportedUsage } from "@/lib/types";

const IMPORTED: ImportedUsage = {
  models: [
    {
      source: "codex",
      model: "gpt-5.6-terra",
      model_matched: true,
      request_count: 12,
      input_tokens: 1000,
      output_tokens: 500,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 3.5
    },
    {
      source: "claude-code",
      model: "some-legacy-model",
      model_matched: false,
      request_count: 4,
      input_tokens: 200,
      output_tokens: 100,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 1.25
    }
  ],
  totals: { request_count: 16, input_tokens: 1200, output_tokens: 600, cost_usd: 4.75 }
};

describe("ImportedSpendSection", () => {
  it("renders a row per (source, model) with friendly source labels and the total", () => {
    render(<ImportedSpendSection imported={IMPORTED} />);
    expect(
      screen.getByRole("heading", { name: "Imported historical spend" })
    ).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-terra")).toBeInTheDocument();
    expect(screen.getByText("some-legacy-model")).toBeInTheDocument();
    // The total attribution is shown in the header.
    expect(screen.getByText(formatCostUsd(4.75))).toBeInTheDocument();
  });

  it("flags an unmatched model so the raw log string reads honestly", () => {
    render(<ImportedSpendSection imported={IMPORTED} />);
    expect(screen.getByText("unmatched")).toBeInTheDocument();
  });

  it("renders nothing when there is no imported usage", () => {
    const { container } = render(
      <ImportedSpendSection
        imported={{
          models: [],
          totals: { request_count: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }
        }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
