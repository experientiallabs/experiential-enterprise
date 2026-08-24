import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// Each workspace surface carries a fallback shaped like the page it precedes
// (the product owner, 2026-07-31): one generic grid skeleton for every page read as the
// wrong page for most of them. These pins are structural, keyed to each
// page's distinctive geometry, so a fallback drifting back to generic fails.
import CreditsLoading from "@/app/(workspace)/credits/loading";
import ModelDetailLoading from "@/app/(workspace)/models/[modelSlug]/loading";
import ModelsLoading from "@/app/(workspace)/models/loading";
import OverviewLoading from "@/app/(workspace)/overview/loading";
import PlaygroundLoading from "@/app/(workspace)/playground/loading";
import TelemetryLoading from "@/app/(workspace)/logs/loading";

// Each primary surface owns its route loading.tsx so the navigation Suspense
// boundary never falls through to the group fallback (a wrong-shape card grid).
// /overview renders NULL (OverviewView paints its own partial skeleton).
// /models renders a catalog-SHAPED skeleton: the old null fallback blanked the
// pane on every navigation (the white flash the product owner saw) — revisits now render
// instantly from the client router cache (next.config staleTimes) and the
// skeleton shows only on a genuinely cold first load.
describe("route loading skeletons match their pages", () => {
  it("models: catalog-shaped skeleton for a true cold load only", () => {
    // The old null fallback WAS the white flash: a loading.tsx replaces the
    // segment during the RSC round trip, so null blanked the pane on every
    // navigation. Revisits no longer suspend at all (next.config staleTimes
    // keeps the payload in the client router cache); this table-shaped
    // skeleton renders only on a genuinely cold first load (the product owner r2).
    const { container } = render(<ModelsLoading />);
    expect(container.firstChild).not.toBeNull();
    // Mirrors the real table shape: a toolbar strip and a rows frame.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it("overview: null fallback (OverviewView paints its own partial skeleton)", () => {
    const { container } = render(<OverviewLoading />);
    expect(container.firstChild).toBeNull();
  });

  it("playground: the transcript-and-rail split with a composer strip", () => {
    const { container } = render(<PlaygroundLoading />);
    expect(container.querySelector('[class*="lg:grid-cols-[minmax(0,1fr)_300px]"]')).not.toBeNull();
    // A tall chat well, not a card grid.
    expect(container.querySelector('[class*="min-h-[280px]"]')).not.toBeNull();
    expect(container.querySelector("aside")).not.toBeNull();
  });

  it("telemetry: filter bar, four stat tiles, a chart well, sections, table rows", () => {
    const { container } = render(<TelemetryLoading />);
    const tiles = container.querySelector('[class*="sm:grid-cols-4"]');
    expect(tiles?.children.length).toBe(4);
    // No-scroll two-column body: spend chart, the Usage breakdown, and the
    // request history.
    expect(container.querySelectorAll("section").length).toBe(3);
    // The chart well under the tiles.
    expect(container.querySelector('[class*="h-[180px]"]')).not.toBeNull();
    expect(container.querySelectorAll('[class*="h-[36px]"]').length).toBeGreaterThanOrEqual(4);
  });

  it("credits: two tabs, the spend card's chart well, and the balance squares", () => {
    // The money page fetches its counters and provider connections server-side
    // before it can render; this fallback stands in with the page's real shape
    // (the two top-line tabs, the combined spend card, the compact provider
    // squares) rather than a generic grid.
    const { container } = render(<CreditsLoading />);
    // Fills the viewport like the page, never a card-grid auto-fill.
    expect(container.firstElementChild?.className).toContain("h-full");
    expect(container.querySelector('[class*="minmax(240px,1fr)"]')).toBeNull();
    // The combined spend card's chart well.
    expect(container.querySelector('[class*="h-[180px]"]')).not.toBeNull();
    // The provider-balance squares: a compact four-up grid of eight tiles.
    const grid = container.querySelector('[class*="lg:grid-cols-4"]');
    expect(grid).not.toBeNull();
    expect(grid?.children.length).toBe(8);
  });

  it("model detail does not inherit the models grid", () => {
    const detail = render(<ModelDetailLoading />).container;
    // Headline strip and the two-column overview, no card grid.
    expect(detail.querySelector('[class*="lg:grid-cols-2"]')).not.toBeNull();
    expect(detail.querySelector('[class*="xl:grid-cols-4"]')).toBeNull();
  });
});
