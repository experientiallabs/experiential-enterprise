import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import OrgLoading from "@/app/(workspace)/loading";
import { AppShell } from "@/components/shell/AppShell";
import { Chip, SkeletonChip } from "@/components/ui/Chip";

describe("ui components", () => {
  it("renders chip-shaped skeleton placeholders", () => {
    const { container } = render(<SkeletonChip />);

    const chip = container.querySelector(".skeleton-chip");
    expect(chip).not.toBeNull();
    expect(chip).toHaveClass("rounded-full");
    expect(chip).toHaveClass("h-[23px]");
  });

  it("renders complete chips as blue rather than success green", () => {
    render(<Chip label="Complete" tone="complete" />);

    const chip = screen.getByText("Complete");
    expect(chip).toHaveClass("bg-blue-50");
    expect(chip).toHaveClass("text-blue-700");
    expect(chip).not.toHaveClass("bg-success-soft");
    expect(chip).not.toHaveClass("text-success");
  });

  it("renders the route fallback as a neutral card grid, not the dead dashboard shape", () => {
    const { container } = render(<OrgLoading />);

    expect(container.firstElementChild).toHaveClass("min-h-full");
    expect(container.firstElementChild).not.toHaveClass("overflow-hidden");
    // Card placeholders matching the /models + /simulations grids.
    expect(container.querySelectorAll("section > div.rounded-lg").length).toBeGreaterThanOrEqual(4);
    // The org-dashboard furniture (bar chart well, stat-tile row) is gone; it
    // belonged to a deleted page and made every navigation paint a phantom
    // chart before the real layout snapped in.
    expect(container.querySelector(".border-dashed")).toBeNull();
    expect(container.querySelector(".grid-cols-4")).toBeNull();
  });

  it("fills the dynamic viewport while allowing content to use the remaining width", () => {
    render(
      <AppShell sidebar={<aside>Navigation</aside>}>
        <section>Content</section>
      </AppShell>
    );

    const shell = screen.getByTestId("app-shell");
    expect(shell).toHaveAttribute("data-layout", "viewport-fill");
    expect(shell.firstElementChild).toHaveTextContent("Navigation");
    expect(shell.querySelector("main")).toContainElement(screen.getByText("Content"));
  });
});
