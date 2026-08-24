import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ContributionGraph, contributionLevel } from "@/components/overview/ContributionGraph";

describe("contributionLevel", () => {
  it("maps zero to empty and quarters of the max to levels 1-4", () => {
    expect(contributionLevel(0, 100)).toBe(0);
    expect(contributionLevel(10, 0)).toBe(0);
    expect(contributionLevel(1, 100)).toBe(1);
    expect(contributionLevel(25, 100)).toBe(1);
    expect(contributionLevel(26, 100)).toBe(2);
    expect(contributionLevel(50, 100)).toBe(2);
    expect(contributionLevel(75, 100)).toBe(3);
    expect(contributionLevel(100, 100)).toBe(4);
  });
});

describe("ContributionGraph", () => {
  const series = [
    { day: "2026-08-16", value: 0 }, // a Sunday
    { day: "2026-08-17", value: 4 },
    { day: "2026-08-18", value: 1 },
    { day: "2026-08-19", value: 0 }
  ];

  it("renders one cell per day with max-relative intensity levels", () => {
    const { container } = render(<ContributionGraph metric="requests" series={series} />);
    const graph = container.querySelector('[data-testid="contribution-graph"]');
    expect(graph).not.toBeNull();
    const cells = graph!.querySelectorAll("rect[data-day]");
    expect(cells).toHaveLength(4);
    expect(graph!.querySelector('[data-day="2026-08-17"]')).toHaveAttribute("data-level", "4");
    expect(graph!.querySelector('[data-day="2026-08-18"]')).toHaveAttribute("data-level", "1");
    expect(graph!.querySelector('[data-day="2026-08-19"]')).toHaveAttribute("data-level", "0");
  });

  it("titles each cell with the metric figure for its day", () => {
    const { container } = render(<ContributionGraph metric="spend" series={[
      { day: "2026-08-19", value: 2_500_000 }
    ]} />);
    const cell = container.querySelector('[data-day="2026-08-19"]');
    expect(cell?.querySelector("title")?.textContent).toBe("$2.50 on 2026-08-19");
  });

  it("stacks days into Sunday-started week columns", () => {
    // 2026-08-16 is a Sunday: all four days share week 0, so all cells share
    // one x while y advances by the row pitch.
    const { container } = render(<ContributionGraph metric="requests" series={series} />);
    const xs = new Set(
      [...container.querySelectorAll("rect[data-day]")].map((cell) => cell.getAttribute("x"))
    );
    expect(xs.size).toBe(1);
  });

  it("renders nothing for an empty series", () => {
    const { container } = render(<ContributionGraph metric="requests" series={[]} />);
    expect(container.querySelector('[data-testid="contribution-graph"]')).toBeNull();
  });
});
