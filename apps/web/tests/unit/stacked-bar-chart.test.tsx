import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StackedBarChart } from "@/components/activity/StackedBarChart";
import { SERIES_PALETTE } from "@/components/telemetry-page/chart-palette";
import { OTHER_SERIES_KEY } from "@/lib/gateway-usage";

// Give useMeasuredSize a real box (jsdom lays nothing out) so the svg and the
// hover geometry render: 600x180 => plot width 544, slot 272 per bucket.
function mockLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 600,
    bottom: 180,
    width: 600,
    height: 180,
    toJSON: () => ({})
  } as DOMRect);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const OTHER_GRAY = "#9ca3af";

// Six ranked models exhaust the palette; the seventh series is the Other fold
// exactly as lib/activity-usage emits it.
const DATA = {
  starts: [Date.parse("2026-08-18T00:00:00Z"), Date.parse("2026-08-19T00:00:00Z")],
  series: [
    ...Array.from({ length: 6 }, (_, index) => ({
      key: `model-${index}`,
      label: `model-${index}`,
      points: [10 - index, 10 - index]
    })),
    { key: OTHER_SERIES_KEY, label: "Other", points: [5, 5] }
  ]
};

function renderChart() {
  return render(
    <StackedBarChart
      data={DATA}
      format={(value) => `$${value.toFixed(2)}`}
      unitLabel="dollars"
      window="7d"
    />
  );
}

describe("StackedBarChart", () => {
  it("paints the Other fold gray instead of cycling back onto rank 1's hue", () => {
    mockLayout();
    const { container } = renderChart();
    // Rank 1 wears the first palette hue on exactly its own segments; the
    // 7th (Other) series wears the recessive gray, never a recycled hue.
    expect(container.querySelectorAll(`rect[fill="${SERIES_PALETTE[0]}"]`)).toHaveLength(2);
    expect(container.querySelectorAll(`rect[fill="${OTHER_GRAY}"]`)).toHaveLength(2);
    // The legend swatch beside "Other" is that same gray.
    const otherSwatch = screen.getByText("Other").querySelector("span[aria-hidden]");
    expect(otherSwatch).toHaveStyle({ backgroundColor: OTHER_GRAY });
  });

  it("shows the bucket breakdown tooltip on hover with matching colors", () => {
    mockLayout();
    const { container } = renderChart();
    const surface = container.querySelector(".overflow-hidden") as HTMLElement;
    fireEvent.mouseMove(surface, { clientX: 100, clientY: 50 });
    const tooltip = screen.getByTestId("stacked-bar-tooltip");
    expect(tooltip).toHaveTextContent("model-0");
    expect(tooltip).toHaveTextContent("Other");
    expect(tooltip).toHaveTextContent("$50.00"); // the bucket total

    fireEvent.mouseLeave(surface);
    expect(screen.queryByTestId("stacked-bar-tooltip")).toBeNull();
  });
});
