import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AnthropicDocsPage from "@/app/docs/anthropic/page";
import { CodeLanguageProvider } from "@/components/docs/code-language";

// The Anthropic Messages guide: /v1/messages, x-api-key auth, any catalog slug,
// and the translation-lane limits. These assertions pin the contract-bearing
// facts, not the prose.
function renderPage() {
  return render(
    <CodeLanguageProvider>
      <AnthropicDocsPage />
    </CodeLanguageProvider>
  );
}

describe("docs anthropic page", () => {
  it("renders the title and CodeTabs blocks in all three languages", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Anthropic API");
    for (const label of ["curl", "Python", "JavaScript"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    }
  });

  it("interpolates the env-driven API base URL into /v1/messages snippets", () => {
    renderPage();
    // No EXPLABS_PUBLIC_BACKEND_URL in tests, so the hosted default renders.
    expect(screen.getAllByText(/api\.experientiallabs\.ai\/v1\/messages/).length).toBeGreaterThan(0);
  });

  it("states the translation-lane limits and the Anthropic error envelope", () => {
    renderPage();
    expect(screen.getByText(/Extended thinking/)).toBeInTheDocument();
    expect(screen.getAllByText(/text-only/).length).toBeGreaterThan(0);
    expect(screen.getByText(/count_tokens/)).toBeInTheDocument();
  });
});
