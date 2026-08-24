import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DailyUsageChart } from "@/components/overview/DailyUsageChart";
import { OTHER_SERIES_KEY, type DailyModelStacks } from "@/lib/gateway-usage";

// Give useMeasuredSize a real box (jsdom lays nothing out) so the svg and the
// hover geometry render: 600x300 => plot width 548, slot 274 per day.
function mockLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 600,
    bottom: 300,
    width: 600,
    height: 300,
    toJSON: () => ({})
  } as DOMRect);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SERIES = [
  { day: "2026-08-18", value: 600 },
  { day: "2026-08-19", value: 1_000_000 }
];

function cell(spend: number, requests = 1, tokens = 100) {
  return {
    requests,
    input_tokens: tokens,
    output_tokens: 0,
    spend_micro_usd: spend
  };
}

const STACKS: DailyModelStacks = {
  days: ["2026-08-18", "2026-08-19"],
  series: [
    { key: "claude-opus-5", label: "claude-opus-5", detail: [cell(500), cell(900_000)] },
    { key: "gpt-5.6", label: "gpt-5.6", detail: [cell(100), cell(0, 0, 0)] },
    { key: OTHER_SERIES_KEY, label: "Other", detail: [cell(0, 0, 0), cell(100_000)] }
  ],
  totals: [cell(600, 2, 200), cell(1_000_000, 2, 200)]
};

describe("DailyUsageChart", () => {
  it("renders flat ink bars with a title tooltip when no stacks are given", () => {
    mockLayout();
    const { container } = render(<DailyUsageChart metric="spend" series={SERIES} />);
    const bars = container.querySelectorAll('rect[fill="var(--ink)"]');
    expect(bars).toHaveLength(2);
    expect(container.querySelector("title")).toHaveTextContent("on 2026-08-18");
    // No breakdown, no legend.
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("stacks each day by model in rank order with a legend", () => {
    mockLayout();
    const { container } = render(
      <DailyUsageChart metric="spend" series={SERIES} stacks={STACKS} />
    );
    // Day 1 stacks claude+gpt, day 2 claude+Other: four segments, none ink.
    expect(container.querySelectorAll('rect[fill="var(--ink)"]')).toHaveLength(0);
    expect(container.querySelectorAll('rect[fill="#1a1a1a"]')).toHaveLength(2); // rank 1
    expect(container.querySelectorAll('rect[fill="#168a49"]')).toHaveLength(1); // rank 2
    expect(container.querySelectorAll('rect[fill="#9ca3af"]')).toHaveLength(1); // Other
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("shows the day breakdown tooltip on hover and hides it on leave", () => {
    mockLayout();
    const { container } = render(
      <DailyUsageChart metric="spend" series={SERIES} stacks={STACKS} />
    );
    const surface = container.querySelector(".overflow-hidden") as HTMLElement;
    // x=400 lands in the second day's slot (plot starts at 44, slot 274).
    fireEvent.mouseMove(surface, { clientX: 400, clientY: 50 });
    const tooltip = screen.getByTestId("daily-usage-tooltip");
    expect(tooltip).toHaveTextContent("Aug 19");
    expect(tooltip).toHaveTextContent("$1.00"); // the day total
    expect(tooltip).toHaveTextContent("claude-opus-5");
    expect(tooltip).toHaveTextContent("$0.90");
    expect(tooltip).toHaveTextContent("Other");
    // gpt-5.6 moved nothing on the 19th, so its row is not listed.
    expect(tooltip).not.toHaveTextContent("gpt-5.6");

    fireEvent.mouseLeave(surface);
    expect(screen.queryByTestId("daily-usage-tooltip")).toBeNull();
  });
});
