import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import AuthenticationDocsPage from "@/app/docs/authentication/page";
import { CodeLanguageProvider } from "@/components/docs/code-language";

// The authentication guide: the xpl_ key shape, the one Bearer header, the
// keyless catalog exception, and the boundary of what one org key can do. These
// assertions pin the contract-bearing facts, not the prose.
function renderPage() {
  return render(
    <CodeLanguageProvider>
      <AuthenticationDocsPage />
    </CodeLanguageProvider>
  );
}

describe("docs authentication page", () => {
  it("renders the title and a CodeTabs verify block in all three languages", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Authentication");
    for (const label of ["curl", "Python", "JavaScript"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("interpolates the env-driven API base URL into the verify snippet", () => {
    renderPage();
    // No EXPLABS_PUBLIC_BACKEND_URL in tests, so the hosted default renders.
    expect(screen.getByText(/api\.experientiallabs\.ai\/v1\/models/)).toBeInTheDocument();
  });

  it("states the invalid_key envelope and the key boundary", () => {
    renderPage();
    expect(screen.getAllByText(/invalid_key/).length).toBeGreaterThan(0);
    // Key creation/revocation is a web-session action, not key-callable.
    expect(screen.getByText(/POST \/api\/keys/)).toBeInTheDocument();
    expect(screen.getByText(/authentication_error/)).toBeInTheDocument();
  });

  it("notes the Anthropic x-api-key alternative header", () => {
    renderPage();
    expect(screen.getAllByText(/x-api-key/).length).toBeGreaterThan(0);
  });
});
