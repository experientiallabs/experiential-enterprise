import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DealsSection } from "@/components/billing/DealsSection";
import type { ProviderConnectionState } from "@/components/settings/ModelProvidersPanel";
import { DISCONNECTED_PROVIDER_CONNECTIONS } from "@/lib/billing/provider-balances";

function connected(provider: ProviderConnectionState["provider"]): ProviderConnectionState {
  return {
    provider,
    connected: true,
    credentialLast4: "1234",
    config: null,
    updatedAt: "2026-08-01T00:00:00Z",
    status: "valid",
    statusDetail: null,
    statusCheckedAt: null,
    spendCredentialLast4: null,
    declaredBalanceUsd: null,
    declaredBalanceSetAt: null,
    meteredSpendUsd: 0,
    lowBalanceThresholdUsd: 5,
    latestSnapshot: null
  };
}

describe("DealsSection", () => {
  it("is framed as inference credit YC deals, terse and em-dash free", () => {
    const { container } = render(<DealsSection connections={DISCONNECTED_PROVIDER_CONNECTIONS} />);
    expect(screen.getByText("Inference credit YC deals")).toBeInTheDocument();
    // The old filler is gone (the product owner, credits redesign 2026-08-22).
    expect(screen.queryByText(/not a live Bookface feed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/terms and eligibility/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("\u2014");
  });

  it("links every deal out to its Bookface deal page", () => {
    render(<DealsSection connections={DISCONNECTED_PROVIDER_CONNECTIONS} />);
    const chip = screen.getByTestId("deal-openai");
    expect(chip.getAttribute("href")).toBe("https://bookface.ycombinator.com/deals/1597");
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(screen.getByTestId("deal-fireworks").getAttribute("href")).toBe(
      "https://bookface.ycombinator.com/deals/2926"
    );
  });

  it("surfaces a claim group for a connected provider", () => {
    render(<DealsSection connections={[connected("openai")]} />);
    expect(screen.getByText("Claim on providers you use")).toBeInTheDocument();
    const chip = screen.getByTestId("deal-openai");
    expect(within(chip).getByText("OpenAI")).toBeInTheDocument();
    expect(chip.getAttribute("href")).toMatch(/bookface\.ycombinator\.com/);
  });

  it("offers every provider deal when nothing is connected", () => {
    render(<DealsSection connections={DISCONNECTED_PROVIDER_CONNECTIONS} />);
    expect(screen.getByText("Deals")).toBeInTheDocument();
    expect(screen.queryByText("Claim on providers you use")).not.toBeInTheDocument();
    expect(screen.getByTestId("deal-anthropic")).toBeInTheDocument();
  });
});
