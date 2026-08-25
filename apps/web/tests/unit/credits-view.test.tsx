import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The add-credits form and the balance grid gate their actions through the
// shell's login-modal hook, mocked at the module seam (the provider lives in
// the app layout).
const loginModalOpen = vi.fn();
vi.mock("@/components/auth/login-modal-context", () => ({
  useLoginModal: () => ({ open: loginModalOpen, requireAuth: (fn: () => void) => fn() })
}));

// The balance grid mounts the shared connect modal, whose per-provider bodies
// call useRouter().refresh() after a mutation.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

import {
  CreditsView,
  EMPTY_USAGE_REPORT,
  USAGE_POLL_INTERVAL_MS
} from "@/components/billing/CreditsView";
import type { OrgUsageReport } from "@/lib/types";

// Public origins the connect modal embeds in each provider's transfer prompt.
const BASE = { apiBaseUrl: "https://api.test", webBaseUrl: "https://web.test" };

const initial: OrgUsageReport = {
  credit: {
    spend_usd: 1.5,
    billable_spend_usd: 1.5,
    credit_granted_usd: 20,
    credit_balance_usd: 18.5,
    yc: null
  }
};

/**
 * Route-aware fetch stub: the spend card reads the timeseries and by-provider
 * rollups on mount, the Settings-tab cards read their own routes. Benign empty
 * shapes for each.
 */
function stubFetchOk() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/usage/timeseries")) {
      return {
        ok: true,
        json: async () => ({ window: "7d", bucket_seconds: 3600, buckets: [] })
      };
    }
    if (url.includes("/usage/by-provider")) {
      return { ok: true, json: async () => ({ window: "7d", providers: [] }) };
    }
    return { ok: true, json: async () => ({ entries: [] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  loginModalOpen.mockClear();
});

describe("CreditsView", () => {
  it("shows honest dollars from the counters, combined (no funding sub-views)", async () => {
    stubFetchOk();
    await act(async () => {
      render(<CreditsView {...BASE} initialReport={initial} orgId="org-1" />);
    });

    expect(screen.getAllByText("$1.50").length).toBeGreaterThan(0);
    expect(screen.getByText("$18.50")).toBeInTheDocument();
    expect(screen.getByText("of $20.00")).toBeInTheDocument();
    // The old fragmentation is gone: no "where your spend goes" split, no
    // separate platform-credits/your-own-keys tiles, no spend hero.
    expect(screen.queryByTestId("spend-attribution")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spend-hero")).not.toBeInTheDocument();
    expect(screen.queryByText("Where your spend goes")).not.toBeInTheDocument();
  });

  it("carries two top-line tabs: the combined view, and Settings", async () => {
    stubFetchOk();
    await act(async () => {
      render(
        <CreditsView
          {...BASE}
          canManageAlerts
          canTopUp
          initialReport={initial}
          isYcCompany
          orgId="org-1"
        />
      );
    });

    // Default tab, in order: spend card, add-credits, balance squares, deals
    // (add-credits sits ABOVE the provider squares — the product owner, 2026-08-23). The
    // deals section shows because this org carries the YC tag (isYcCompany).
    expect(screen.getByTestId("spend-overview")).toBeInTheDocument();
    expect(screen.getByTestId("provider-balances")).toBeInTheDocument();
    expect(screen.getByTestId("add-credits")).toBeInTheDocument();
    expect(screen.getByTestId("deals-section")).toBeInTheDocument();
    const before = (first: string, second: string) =>
      Boolean(
        screen.getByTestId(first).compareDocumentPosition(screen.getByTestId(second)) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
    expect(before("spend-overview", "add-credits")).toBe(true);
    expect(before("add-credits", "provider-balances")).toBe(true);
    expect(before("provider-balances", "deals-section")).toBe(true);
    expect(screen.queryByTestId("auto-recharge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("credit-history")).not.toBeInTheDocument();

    // Settings tab: auto-recharge, spend alerts, history — nothing else.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    });
    expect(screen.getByTestId("spend-alerts")).toBeInTheDocument();
    expect(screen.getByTestId("credit-history")).toBeInTheDocument();
    expect(screen.queryByTestId("spend-overview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deals-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-credits")).not.toBeInTheDocument();
  });

  it("hides the YC deals section for an org without the YC tag", async () => {
    stubFetchOk();
    await act(async () => {
      render(
        <CreditsView {...BASE} canManageAlerts canTopUp initialReport={initial} orgId="org-1" />
      );
    });
    // Overview tab renders, but the Bookface deals section is YC-only.
    expect(screen.getByTestId("provider-balances")).toBeInTheDocument();
    expect(screen.queryByTestId("deals-section")).not.toBeInTheDocument();
  });

  it("shows no tool accounts anywhere on the money page", async () => {
    stubFetchOk();
    await act(async () => {
      render(
        <CreditsView {...BASE} canManageAlerts canTopUp initialReport={initial} orgId="org-1" />
      );
    });

    expect(screen.queryByTestId("tool-accounts")).not.toBeInTheDocument();
    expect(screen.queryByText("Tool accounts")).not.toBeInTheDocument();
    expect(screen.queryByText("E2B")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    });
    expect(screen.queryByText("Tool accounts")).not.toBeInTheDocument();
  });

  it("offers the $25/$100/$500 presets plus a custom amount to admins, right on the main tab", async () => {
    stubFetchOk();
    await act(async () => {
      render(<CreditsView {...BASE} canTopUp initialReport={initial} orgId="org-1" />);
    });

    for (const preset of ["$25", "$100", "$500"]) {
      expect(screen.getByRole("button", { name: preset })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Custom top-up amount in USD")).toBeInTheDocument();
  });

  it("hides the add-credits card from a member who cannot top up", async () => {
    stubFetchOk();
    await act(async () => {
      render(<CreditsView {...BASE} initialReport={initial} orgId="org-1" />);
    });

    expect(screen.queryByTestId("add-credits")).not.toBeInTheDocument();
  });

  it("renders a negative balance honestly, styled as a warning", async () => {
    stubFetchOk();
    await act(async () => {
      render(
        <CreditsView
          {...BASE}
          initialReport={{
            credit: {
              spend_usd: 20.43,
              billable_spend_usd: 20.43,
              credit_granted_usd: 20,
              credit_balance_usd: -0.43,
              yc: null
            }
          }}
          orgId="org-1"
        />
      );
    });

    const balance = screen.getByText("-$0.43");
    expect(balance).toBeInTheDocument();
    expect(balance.className).toContain("text-warning");
  });

  it("shows the low-balance banner under one top-up of runway, signed-in only", async () => {
    stubFetchOk();
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <CreditsView
          {...BASE}
          canTopUp
          initialReport={{
            credit: {
              spend_usd: 19,
              billable_spend_usd: 19,
              credit_granted_usd: 20,
              credit_balance_usd: 1,
              yc: null
            }
          }}
          orgId="org-1"
        />
      );
    });

    expect(screen.getByTestId("low-balance-banner")).toBeInTheDocument();
    expect(screen.getByText(/almost out of credits/)).toBeInTheDocument();

    // A healthy balance shows no banner.
    await act(async () => {
      view?.rerender(<CreditsView {...BASE} canTopUp initialReport={initial} orgId="org-1" />);
    });
    expect(screen.queryByTestId("low-balance-banner")).not.toBeInTheDocument();
  });

  it("renders signed-out with empty-state numbers, gated actions, and zero fetches", async () => {
    const fetchMock = stubFetchOk();
    await act(async () => {
      render(<CreditsView {...BASE} initialReport={EMPTY_USAGE_REPORT} orgId={null} />);
    });

    // Empty-state numbers, not a locked card: spend and credits-left at zero.
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(screen.getByText("of $0.00")).toBeInTheDocument();
    // The full add-credits form renders on the main tab; only the action gates login.
    expect(screen.getByRole("button", { name: "$25" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to payment" })).toBeInTheDocument();
    // Zero balance as a placeholder is not a low balance.
    expect(screen.queryByTestId("low-balance-banner")).not.toBeInTheDocument();
    // No account-scoped data fetch may fire signed-out (design-system contract).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never navigates away to connect: the grid opens the modal in place", async () => {
    stubFetchOk();
    await act(async () => {
      render(<CreditsView {...BASE} canManageProviders initialReport={initial} orgId="org-1" />);
    });

    // The old link-out entry is gone; connecting happens on this page.
    expect(screen.queryByTestId("connect-provider-entry")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage providers" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI" }));
    });
    expect(screen.getByTestId("provider-connect-modal-openai")).toBeInTheDocument();
  });

  it("keeps the counters fresh on the usage poll", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/usage")) {
        return {
          ok: true,
          json: async () => ({
            credit: {
              spend_usd: 2.5,
              billable_spend_usd: 2.5,
              credit_granted_usd: 20,
              credit_balance_usd: 17.5,
              yc: null
            }
          })
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<CreditsView {...BASE} initialReport={initial} orgId="org-1" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_POLL_INTERVAL_MS);
    });

    expect(screen.getByText("$17.50")).toBeInTheDocument();
  });
});
