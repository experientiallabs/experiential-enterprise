import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DocsOverviewPage from "@/app/docs/page";
import { CodeLanguageProvider } from "@/components/docs/code-language";
import { docsPath, isReservedRouteSlug, reservedSlugRedirect } from "@/lib/routes";

// The docs landing page in the P1 scaffold: a live CodeTabs block wired to the
// one base-URL module, and the section map. docs-P2 replaces the copy; these
// assertions pin the scaffold mechanics, not the prose.
function renderOverview() {
  return render(
    <CodeLanguageProvider>
      <DocsOverviewPage />
    </CodeLanguageProvider>
  );
}

describe("docs overview page", () => {
  it("renders the title and a CodeTabs block with all three languages and copy", () => {
    renderOverview();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Overview");
    for (const label of ["curl", "Python", "JavaScript"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("interpolates the env-driven API base URL into the snippet (default: hosted)", () => {
    renderOverview();
    // No EXPLABS_PUBLIC_BACKEND_URL in tests, so the hosted default renders.
    expect(
      screen.getByText(/api\.experientiallabs\.ai\/v1\/chat\/completions/)
    ).toBeInTheDocument();
  });

  it("introduces Experiential Cloud with the product sentence", () => {
    renderOverview();
    expect(
      screen.getByText(
        /Experiential Cloud is a curated collection of models, hosted and optimized by Experiential Labs/
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/native vLLM/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/platform-operated/i)).not.toBeInTheDocument();
  });

  it("links every public docs section and the machine-readable llms.txt", () => {
    renderOverview();
    // The prose links to a few pages inline as well as in the section map, so a
    // section may be linked more than once; assert each destination is present
    // at least once rather than exactly once.
    for (const [name, href] of [
      ["Quickstart", "/docs/quickstart"],
      ["The core loop", "/docs/core-loop"],
      ["Models", "/docs/models"],
      ["Errors", "/docs/errors"],
      ["API reference", "/docs/reference"]
    ] as const) {
      const links = screen.getAllByRole("link", { name: new RegExp(name) });
      expect(links.some((link) => link.getAttribute("href") === href)).toBe(true);
    }
    expect(screen.getByRole("link", { name: "/llms.txt" })).toHaveAttribute("href", "/llms.txt");
    // The internal reference stays invisible.
    expect(screen.queryByRole("link", { name: /internal/i })).not.toBeInTheDocument();
  });

  it("is a reserved route a model slug cannot shadow", () => {
    expect(isReservedRouteSlug("docs")).toBe(true);
    expect(reservedSlugRedirect("docs")).toBe(docsPath());
  });
});
