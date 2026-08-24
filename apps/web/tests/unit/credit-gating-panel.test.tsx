import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditGatingPanel } from "@/components/admin/CreditGatingPanel";
import type { CreditGatingSettings } from "@/lib/types";

const DEFAULTS: CreditGatingSettings = {
  welcome_grant_micro_usd: 20_000_000,
  yc_grant_micro_usd: 526_000_000,
  pre_verify_allowance_micro_usd: 1_000_000,
  pre_verify_enabled: true,
  spend_unlock_requirement: "email"
};

/** A fetch double whose stored settings mutate on PUT, like the real backend. */
function stubBackend(initial: CreditGatingSettings = DEFAULTS) {
  let current = { ...initial };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/pre-verify-allowance")) {
        current = {
          ...current,
          pre_verify_enabled: body.enabled,
          pre_verify_allowance_micro_usd: body.enabled ? 1_000_000 : 0
        };
      } else if (url.endsWith("/welcome-grant")) {
        current = { ...current, welcome_grant_micro_usd: body.micro_usd };
      } else if (url.endsWith("/yc-grant")) {
        current = { ...current, yc_grant_micro_usd: body.micro_usd };
      } else if (url.endsWith("/spend-unlock-requirement")) {
        current = { ...current, spend_unlock_requirement: body.requirement };
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } })
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreditGatingPanel", () => {
  it("shows the consolidated summary and current values", async () => {
    stubBackend();
    render(<CreditGatingPanel />);

    await waitFor(() => expect(screen.getByText(/New users get/)).toBeInTheDocument());
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("$526.00")).toBeInTheDocument();
    expect(screen.getByText(/for YC companies/)).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Welcome grant amount in dollars") as HTMLInputElement).value
    ).toBe("20");
    expect(
      (screen.getByLabelText("YC launch grant amount in dollars") as HTMLInputElement).value
    ).toBe("526");
    expect(
      screen.getByRole("radio", { name: "Email verification" }).getAttribute("aria-checked")
    ).toBe("true");
  });

  it("toggles the pre-verify allowance off", async () => {
    const fetchMock = stubBackend();
    render(<CreditGatingPanel />);

    await waitFor(() => expect(screen.getByTestId("pre-verify-state")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Require verification for all credits" }));

    await waitFor(() =>
      expect(screen.getByText(/must verify before spending any credit/)).toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings/pre-verify-allowance",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false }) })
    );
  });

  it("edits the welcome grant amount and saves micro-USD", async () => {
    const fetchMock = stubBackend();
    render(<CreditGatingPanel />);

    const input = (await screen.findByLabelText(
      "Welcome grant amount in dollars"
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50" } });
    // The welcome card is the first grant row, so its Save is the first one.
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/settings/welcome-grant",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ micro_usd: 50_000_000 }) })
      )
    );
  });

  it("switches the spend-unlock requirement to credit card", async () => {
    const fetchMock = stubBackend();
    render(<CreditGatingPanel />);

    await screen.findByText(/New users get/);
    fireEvent.click(screen.getByRole("radio", { name: "Credit card" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/settings/spend-unlock-requirement",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ requirement: "card" }) })
      )
    );
    await waitFor(() => expect(screen.getByText(/adding a credit card/)).toBeInTheDocument());
  });

  it("surfaces a load failure with a retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<CreditGatingPanel />);

    await waitFor(() =>
      expect(screen.getByText("Credit settings unavailable")).toBeInTheDocument()
    );
  });
});
