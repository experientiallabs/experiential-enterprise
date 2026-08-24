import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => vi.fn());
vi.mock("@/components/auth/login-modal-context", () => ({
  useLoginModal: () => ({ open, close: vi.fn(), isOpen: false })
}));

import { AddCreditsCard } from "@/components/billing/AddCreditsCard";
import { AutoRechargeCard } from "@/components/billing/AutoRechargeCard";
import type { AutoRechargeSettings } from "@/lib/billing/constants";

const SETTINGS: AutoRechargeSettings = {
  enabled: true,
  thresholdUsd: 10,
  amountUsd: 5,
  hasPaymentMethod: true,
  lastRechargeAt: null,
  consecutiveFailures: 0,
  lastFailureMessage: null
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddCreditsCard auto-recharge consent", () => {
  it("checks the consent by default and passes it to checkout", async () => {
    vi.stubGlobal("location", { search: "", assign: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://stripe.example/checkout" })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddCreditsCard orgId="org-1" />);

    const consent = screen.getByLabelText("Auto-recharge amount in USD") as HTMLInputElement;
    expect(consent).toBeInTheDocument();
    // The checkbox inside the consent label is checked out of the box.
    const checkbox = screen
      .getByTestId("auto-recharge-consent")
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.auto_recharge).toEqual({ enabled: true, amount_usd: 5, threshold_usd: 10 });
  });

  it("opts out when the consent is unchecked", async () => {
    vi.stubGlobal("location", { search: "", assign: vi.fn() });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://stripe.example/checkout" })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddCreditsCard orgId="org-1" />);
    const checkbox = screen
      .getByTestId("auto-recharge-consent")
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.auto_recharge).toEqual({ enabled: false });
  });
});

describe("AutoRechargeCard", () => {
  it("renders the honest current state and saves an edited amount", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const patched = { ...SETTINGS, amountUsd: 25 };
        return Promise.resolve({ ok: true, json: async () => patched });
      }
      return Promise.resolve({ ok: true, json: async () => SETTINGS });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<AutoRechargeCard orgId="org-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("auto-recharge-state")).toHaveTextContent(
        "Auto-recharge is on: we'll add $5.00 whenever your balance drops below $10.00."
      )
    );

    const amount = screen.getByLabelText("Auto-recharge amount in USD");
    fireEvent.change(amount, { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((call) => call[1]?.method === "PATCH");
      expect(patchCall).toBeDefined();
      expect(JSON.parse(patchCall![1]!.body as string)).toMatchObject({
        amount_usd: 25,
        threshold_usd: 10
      });
    });
  });

  it("shows the failed state after a decline", async () => {
    const failing: AutoRechargeSettings = {
      ...SETTINGS,
      consecutiveFailures: 1,
      lastFailureMessage: "Your card was declined."
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => failing });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<AutoRechargeCard orgId="org-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("auto-recharge-failed")).toHaveTextContent(
        "Your card was declined."
      )
    );
  });

  it("explains the no-card state before a card is saved", async () => {
    const noCard: AutoRechargeSettings = { ...SETTINGS, hasPaymentMethod: false };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => noCard });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<AutoRechargeCard orgId="org-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("auto-recharge-state")).toHaveTextContent(
        "once a card is on file"
      )
    );
  });
});
