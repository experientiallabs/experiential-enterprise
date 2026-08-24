import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// The Telemetry nav entry does not wait for traffic, so the never-used state
// is many members' first sight of the surface. The page keeps its full
// outline (tiles, chart, tables reading zero) and adds ONE actionable
// section: the exact copyable call that produces a first request when a
// model exists, or the create door when none does (the product owner, 2026-07-30).
import { FirstCallSection } from "@/components/telemetry-page/first-call";
import { buttonClassName } from "@/components/ui/Button";

describe("telemetry never-used state", () => {
  it("offers the model's first call, copyable, with the playground door", () => {
    render(
      <FirstCallSection
        firstCall={{ modelName: "support-prod", baseUrl: "https://api.example.test" }}
      />
    );

    expect(screen.getByRole("heading", { name: "No usage yet" })).toBeInTheDocument();
    const snippet = screen.getByText(/curl "https:\/\/api\.example\.test\/v1\/chat\/completions"/);
    expect(snippet.textContent).toContain('"model": "support-prod"');
    expect(screen.getByRole("button", { name: "Copy endpoint curl example" })).toBeInTheDocument();
    const playground = screen.getByRole("link", { name: /Open in playground/ });
    expect(playground).toHaveAttribute("href", "/playground?model=support-prod");
    // Normalized with the model page's API card: the shared PlaygroundLink
    // (ink button, gamepad mark), not a page-local styling.
    expect(playground.className).toBe(buttonClassName("primary", undefined, "sm"));
    expect(playground.querySelector("svg")).not.toBeNull();
  });

  it("offers the create door when the org has no model to call", () => {
    render(<FirstCallSection firstCall={null} />);

    expect(screen.getByRole("heading", { name: "No usage yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a model" })).toHaveAttribute("href", "/models");
    expect(screen.queryByRole("button", { name: "Copy endpoint curl example" })).toBeNull();
  });
});
