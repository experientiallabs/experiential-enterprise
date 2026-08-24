import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DocsSidebar } from "@/components/docs/DocsSidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs/errors" }));

describe("DocsSidebar", () => {
  it("renders the grouped IA with the current page marked", () => {
    render(<DocsSidebar />);
    for (const group of ["Get started", "Guides", "Reference"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Errors" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Quickstart" })).not.toHaveAttribute("aria-current");
    // The admin-only internal reference is never listed.
    expect(screen.queryByRole("link", { name: /internal/i })).not.toBeInTheDocument();
  });

  it("renders the same pages in the horizontal (small-viewport) strip", () => {
    render(<DocsSidebar horizontal />);
    for (const name of ["Overview", "Quickstart", "The core loop", "Models", "Errors", "API reference"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Errors" })).toHaveAttribute("aria-current", "page");
  });
});
