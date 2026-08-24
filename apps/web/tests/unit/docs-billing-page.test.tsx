import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import BillingDocsPage from "@/app/docs/billing/page";
import { CodeLanguageProvider } from "@/components/docs/code-language";

// The credits & billing guide: the two lanes, the credit model, the three spend
// controls, and insufficient_quota. These assertions pin the contract-bearing
// facts, not the prose.
function renderPage() {
  return render(
    <CodeLanguageProvider>
      <BillingDocsPage />
    </CodeLanguageProvider>
  );
}

describe("docs billing page", () => {
  it("renders the title and a CodeTabs limits block in all three languages", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Credits & billing");
    for (const label of ["curl", "Python", "JavaScript"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("interpolates the env-driven API base URL into the key-limits snippet", () => {
    renderPage();
    // No EXPLABS_PUBLIC_BACKEND_URL in tests, so the hosted default renders.
    expect(screen.getByText(/api\.experientiallabs\.ai\/api\/gateway\/keys/)).toBeInTheDocument();
  });

  it("distinguishes the two lanes and their metering fields", () => {
    renderPage();
    expect(screen.getAllByText(/Platform-funded/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cost_micro_usd/).length).toBeGreaterThan(0);
    expect(screen.getByText(/estimated_cost_micro_usd/)).toBeInTheDocument();
  });

  it("names the per-key limit fields and the insufficient_quota outcome", () => {
    renderPage();
    expect(screen.getByText("tokens_per_minute")).toBeInTheDocument();
    expect(screen.getByText("daily_spend_cap_micro_usd")).toBeInTheDocument();
    expect(screen.getByText(/insufficient_quota/)).toBeInTheDocument();
  });
});
