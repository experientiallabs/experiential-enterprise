import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WelcomeCelebration } from "@/components/auth/WelcomeCelebration";

// The confetti is a decorative animation; stub it so the test focuses on the
// minimal content contract (credits line, API key gating, prompts, links).
vi.mock("@/components/auth/ConfettiBurst", () => ({ ConfettiBurst: () => null }));

const BASE = {
  webBaseUrl: "https://platform.experientiallabs.ai",
  apiBaseUrl: "https://api.experientiallabs.ai",
  onClose: () => {}
};

describe("WelcomeCelebration (minimal welcome modal)", () => {
  it("announces the credit amount and shows the API key when opted in", () => {
    render(<WelcomeCelebration grantedUsd={526} apiKey="xpl_secret_123" showApiKey {...BASE} />);

    expect(screen.getByTestId("welcome-credits-line").textContent).toContain("$526");
    expect(screen.getByText("xpl_secret_123")).toBeTruthy();
    expect(screen.getByText("Paste into your coding agent")).toBeTruthy();
    // The two quick links: Docs + the machine-readable llms.txt.
    const llms = screen.getByText("llms.txt").closest("a");
    expect(llms?.getAttribute("href")).toBe("https://platform.experientiallabs.ai/llms.txt");
    expect(screen.getByText("Docs")).toBeTruthy();
  });

  it("hides the API key block when showApiKey is false", () => {
    render(
      <WelcomeCelebration grantedUsd={526} apiKey="xpl_secret_123" showApiKey={false} {...BASE} />
    );

    expect(screen.queryByText("xpl_secret_123")).toBeNull();
    expect(screen.queryByText("API key")).toBeNull();
    // The prompts still render (with a fill-in slot).
    expect(screen.getByText("Paste into your coding agent")).toBeTruthy();
  });

  it("omits the credits line when there is no amount to announce", () => {
    render(<WelcomeCelebration grantedUsd={null} apiKey={null} showApiKey {...BASE} />);

    expect(screen.queryByTestId("welcome-credits-line")).toBeNull();
    expect(screen.queryByText("API key")).toBeNull();
  });
});
