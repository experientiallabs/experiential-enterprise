import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocsSearch } from "@/components/docs/DocsSearch";
import { searchDocs } from "@/components/docs/docs-search";
import { docsErrorsPath, docsInternalPath, docsQuickstartPath } from "@/lib/routes";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push })
}));

describe("searchDocs", () => {
  it("ranks title matches first and matches keywords and descriptions", () => {
    expect(searchDocs("quick")[0]?.path).toBe(docsQuickstartPath());
    expect(searchDocs("error")[0]?.path).toBe(docsErrorsPath());
    // "byok" appears only in the Models page keywords.
    expect(searchDocs("byok").map((entry) => entry.path)).toContain("/docs/models");
  });

  it("returns nothing for blank or unmatched queries", () => {
    expect(searchDocs("")).toEqual([]);
    expect(searchDocs("   ")).toEqual([]);
    expect(searchDocs("zzzz-no-such-page")).toEqual([]);
  });

  it("never surfaces the admin-only internal page", () => {
    for (const query of ["internal", "admin", "docs", "reference"]) {
      expect(searchDocs(query).map((entry) => entry.path)).not.toContain(docsInternalPath());
    }
  });
});

describe("DocsSearch", () => {
  beforeEach(() => {
    push.mockClear();
  });

  it("opens from the trigger, filters as you type, and navigates on Enter", () => {
    render(<DocsSearch />);
    fireEvent.click(screen.getByRole("button", { name: /search docs/i }));
    const input = screen.getByRole("textbox", { name: "Search docs" });
    fireEvent.change(input, { target: { value: "quick" } });
    expect(screen.getByText("Quickstart")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith(docsQuickstartPath());
    // Navigating closes the modal.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on the ⌘K shortcut and closes on Escape", () => {
    render(<DocsSearch />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Search documentation" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    render(<DocsSearch />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Search docs" }), {
      target: { value: "zzzz" }
    });
    expect(screen.getByText(/No pages match/)).toBeInTheDocument();
  });
});
