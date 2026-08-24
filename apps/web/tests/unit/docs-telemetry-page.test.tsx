import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TelemetryDocsPage from "@/app/docs/telemetry/page";
import { CodeLanguageProvider } from "@/components/docs/code-language";

// The telemetry guide: usage rollups, the per-request event stream, and the
// trace-ingest routes. These assertions pin the contract-bearing facts, not the
// prose.
function renderPage() {
  return render(
    <CodeLanguageProvider>
      <TelemetryDocsPage />
    </CodeLanguageProvider>
  );
}

describe("docs telemetry page", () => {
  it("renders the title and CodeTabs blocks in all three languages", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Telemetry");
    for (const label of ["curl", "Python", "JavaScript"]) {
      expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    }
  });

  it("interpolates the env-driven API base URL into the usage snippets", () => {
    renderPage();
    // No EXPLABS_PUBLIC_BACKEND_URL in tests, so the hosted default renders.
    expect(screen.getAllByText(/api\.experientiallabs\.ai\/api\/gateway\/usage\/daily/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/api\.experientiallabs\.ai\/api\/gateway\/usage\/events/).length).toBeGreaterThan(0);
  });

  it("documents the trace-ingest routes and the verify counts", () => {
    renderPage();
    expect(screen.getAllByText(/telemetry\/traces\/pull/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/telemetry\/traces\/upload/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/finalize/).length).toBeGreaterThan(0);
    expect(screen.getByText(/total_ingests/)).toBeInTheDocument();
    expect(screen.getByText(/total_traces/)).toBeInTheDocument();
  });

  it("sends the pull credential as a colon-delimited string, not an object", () => {
    renderPage();
    // The backend credential field is a single string (public:secret for
    // Langfuse); an object would 422 before ingestion.
    expect(screen.getAllByText(/pk-lf-\.\.\.:sk-lf-\.\.\./).length).toBeGreaterThan(0);
  });
});
