import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityView } from "@/components/activity/activity-view";
import type { UsageBucket, UsageByKey, UsageByProvider, UsageTimeseries } from "@/lib/types";

const NOW_MS = Date.parse("2026-08-22T12:00:00Z");
const SLOT = "2026-08-22T00:00:00.000Z";

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    bucket_start: SLOT,
    model: "gpt-5.6",
    lane: "platform",
    request_count: 3,
    error_count: 0,
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 4,
    estimated_cost_usd: 0,
    ...overrides
  };
}

const timeseries: UsageTimeseries = {
  window: "7d",
  bucket_seconds: 86_400,
  buckets: [bucket({ model: "gpt-5.6", cost_usd: 4 }), bucket({ model: "claude-opus-5", cost_usd: 6 })]
};

const byKey: UsageByKey = {
  window: "7d",
  keys: [
    {
      api_key_id: "k1",
      key_label: "prod",
      models: [],
      totals: {
        request_count: 6,
        error_count: 0,
        input_tokens: 3000,
        output_tokens: 1500,
        cost_usd: 10,
        estimated_cost_usd: 0
      },
      last_used_at: SLOT
    }
  ]
};

const byProvider: UsageByProvider = {
  window: "7d",
  providers: [
    {
      provider: "anthropic",
      request_count: 6,
      error_count: 0,
      input_tokens: 3000,
      output_tokens: 1500,
      cost_usd: 10,
      estimated_cost_usd: 0,
      last_used_at: SLOT
    }
  ]
};

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  );
});

function renderView(knownModelSlugs: string[] | null = null) {
  return render(
    <ActivityView
      byKey={byKey}
      byPrompt={{ window: "7d", prompts: [] }}
      byProvider={byProvider}
      canManagePromptCapture={false}
      knownModelSlugs={knownModelSlugs}
      nowMs={NOW_MS}
      orgId="org-1"
      suggestions={[]}
      timeseries={timeseries}
      window="7d"
    />
  );
}

describe("ActivityView", () => {
  it("shows the deep graphs by default: stat cards, charts, and ranked lists", () => {
    renderView();
    // Stat cards row with the four summary figures.
    const statCards = screen.getByTestId("activity-stat-cards");
    expect(within(statCards).getByText("Total spend")).toBeInTheDocument();
    expect(within(statCards).getByText("Blended $/1M")).toBeInTheDocument();
    // All-spend = 4 + 6 = $10.00.
    expect(within(statCards).getByText("$10.00")).toBeInTheDocument();
    // The stacked charts and the lane split all render up front (no toggles).
    expect(screen.getAllByTestId("stacked-bar-chart").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("spend-chart")).toBeInTheDocument();
    // Ranked panels are present.
    expect(screen.getByText("Top models by spend")).toBeInTheDocument();
    expect(screen.getByText("Top API keys")).toBeInTheDocument();
    expect(screen.getByText("Providers")).toBeInTheDocument();
    // The top model shows in the ranked list (and the chart legend).
    expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThanOrEqual(1);
  });

  it("links each top-model row to its catalog page with the raw slug", () => {
    renderView();
    const link = screen.getByRole("link", { name: /claude-opus-5/ });
    expect(link).toHaveAttribute("href", "/models/claude-opus-5");
  });

  it("does not link a top model the catalog no longer carries", () => {
    // A known slug list that misses claude-opus-5 (delisted): its row stays
    // flat while gpt-5.6 keeps its link.
    renderView(["gpt-5.6"]);
    expect(screen.queryByRole("link", { name: /claude-opus-5/ })).toBeNull();
    expect(screen.getByRole("link", { name: /gpt-5\.6/ })).toHaveAttribute(
      "href",
      "/models/gpt-5.6"
    );
  });

  it("folds Intelligence in as a second tab", () => {
    renderView();
    // The Intelligence surface is not the default view.
    expect(screen.queryByRole("heading", { name: "Ask your usage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Intelligence" }));
    // The natural-language query (the old Insights body) now shows.
    expect(screen.getByRole("heading", { name: "Ask your usage" })).toBeInTheDocument();
  });
});
