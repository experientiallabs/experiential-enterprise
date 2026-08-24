import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecommendedStar } from "@/components/models-catalog/recommended-star";

// The recommended marker is the primary, scannable signal that a model is
// preferred (the product owner, r2: the faint-green tint alone was not obvious enough). It
// must render a real gold-filled star glyph with an accessible label, never
// blank.
describe("RecommendedStar", () => {
  it("renders a labeled star glyph filled with the gold accent token", () => {
    const { container } = render(<RecommendedStar />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toBe("Recommended");
    expect(svg?.getAttribute("class")).toContain("fill-accent-amber");
  });
});
