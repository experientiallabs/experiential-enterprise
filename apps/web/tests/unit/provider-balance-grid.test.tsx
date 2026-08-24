import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const loginModalOpen = vi.fn();
vi.mock("@/components/auth/login-modal-context", () => ({
  useLoginModal: () => ({ open: loginModalOpen, requireAuth: (fn: () => void) => fn() })
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

import { ProviderBalanceGrid } from "@/components/billing/ProviderBalanceGrid";
import type { ProviderConnectionState } from "@/components/settings/ModelProvidersPanel";
import { DISCONNECTED_PROVIDER_CONNECTIONS } from "@/lib/billing/provider-balances";
import { MODEL_PROVIDERS } from "@/lib/model-providers";

const BASE = {
  apiBaseUrl: "https://api.test",
  webBaseUrl: "https://web.test",
  canManage: true,
  isYcCompany: false
};

function connection(
  overrides: Partial<ProviderConnectionState> & { provider: ProviderConnectionState["provider"] }
): ProviderConnectionState {
  return {
    connected: false,
    credentialLast4: null,
    config: null,
    updatedAt: null,
    status: "unchecked",
    statusDetail: null,
    statusCheckedAt: null,
    spendCredentialLast4: null,
    declaredBalanceUsd: null,
    declaredBalanceSetAt: null,
    meteredSpendUsd: 0,
    lowBalanceThresholdUsd: 5,
    latestSnapshot: null,
    ...overrides
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  loginModalOpen.mockClear();
});

describe("ProviderBalanceGrid", () => {
  it("renders one compact square per provider with its connected state and balance", () => {
    render(
      <ProviderBalanceGrid
        {...BASE}
        connections={[
          connection({
            provider: "openai",
            connected: true,
            credentialLast4: "ab12",
            declaredBalanceUsd: 100,
            meteredSpendUsd: 12.5
          }),
          ...DISCONNECTED_PROVIDER_CONNECTIONS.filter((c) => c.provider !== "openai")
        ]}
        orgId="org-1"
      />
    );

    // Every provider gets a tile.
    for (const provider of MODEL_PROVIDERS) {
      expect(screen.getByTestId(`provider-balance-${provider}`)).toBeInTheDocument();
    }
    // Connected: state, tracked balance (declared minus metered), key spend.
    const openai = screen.getByTestId("provider-balance-openai");
    expect(openai).toHaveAttribute("data-connected", "true");
    expect(within(openai).getByText("Connected")).toBeInTheDocument();
    expect(within(openai).getByText("$87.50")).toBeInTheDocument();
    expect(within(openai).getByText("$12.50 spent on this key")).toBeInTheDocument();
    // Not connected: an honest state and a connect affordance, never a fake $0.
    const gemini = screen.getByTestId("provider-balance-gemini");
    expect(within(gemini).getByText("Not connected")).toBeInTheDocument();
    expect(within(gemini).getByText("Connect")).toBeInTheDocument();
    expect(within(gemini).queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("opens the shared connect modal IN PLACE, with the starting-balance field", () => {
    render(
      <ProviderBalanceGrid {...BASE} connections={DISCONNECTED_PROVIDER_CONNECTIONS} orgId="org-1" />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI" }));
    // The SAME settings modal, mounted here — no navigation.
    expect(screen.getByTestId("provider-connect-modal-openai")).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
    // The credits-page extra: an optional starting balance on the connect form.
    expect(
      screen.getByLabelText("Starting OpenAI credits balance in USD (optional)")
    ).toBeInTheDocument();
  });

  it("declares the starting balance right after a successful connect", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        return { ok: true, json: async () => ({ check: null }) };
      })
    );
    render(
      <ProviderBalanceGrid {...BASE} connections={DISCONNECTED_PROVIDER_CONNECTIONS} orgId="org-1" />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI" }));
    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-proj-test" }
    });
    fireEvent.change(screen.getByLabelText("Starting OpenAI credits balance in USD (optional)"), {
      target: { value: "250" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/provider-connections/openai");
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].body).toEqual({ declared_balance_usd: 250 });
  });

  it("links each provider's YC deal inside the tile for a YC org only", () => {
    const { rerender } = render(
      <ProviderBalanceGrid
        {...BASE}
        connections={DISCONNECTED_PROVIDER_CONNECTIONS}
        isYcCompany
        orgId="org-1"
      />
    );

    const deal = screen.getByTestId("yc-deal-openai");
    expect(deal).toHaveAttribute("href", "https://bookface.ycombinator.com/deals/1597");
    expect(deal).toHaveTextContent("YC deal");
    // The FINAL verified mapping: AWS (Bedrock) is /deals/3, Microsoft is
    // exactly /deals/2155 — one link each.
    expect(screen.getByTestId("yc-deal-aws")).toHaveAttribute(
      "href",
      "https://bookface.ycombinator.com/deals/3"
    );
    const microsoft = screen.getByTestId("yc-deal-microsoft");
    expect(microsoft).toHaveAttribute("href", "https://bookface.ycombinator.com/deals/2155");
    expect(microsoft).toHaveTextContent("YC deal");
    expect(screen.queryByTestId("yc-deal-microsoft-2")).not.toBeInTheDocument();

    rerender(
      <ProviderBalanceGrid
        {...BASE}
        connections={DISCONNECTED_PROVIDER_CONNECTIONS}
        isYcCompany={false}
        orgId="org-1"
      />
    );
    expect(screen.queryByTestId("yc-deal-openai")).not.toBeInTheDocument();
  });

  it("gates the connect action behind login when signed out, without navigating", () => {
    render(
      <ProviderBalanceGrid {...BASE} connections={DISCONNECTED_PROVIDER_CONNECTIONS} orgId={null} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI" }));
    expect(loginModalOpen).toHaveBeenCalled();
    expect(screen.queryByTestId("provider-connect-modal-openai")).not.toBeInTheDocument();
  });
});
