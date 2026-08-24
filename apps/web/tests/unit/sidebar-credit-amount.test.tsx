import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarCreditAmount } from "@/components/shell/SidebarCreditAmount";

// SidebarCreditAmount embeds the credit greeting bubble, whose atomic claim is
// its own network call. Stub it to a never-settling promise so it neither draws
// from this suite's budget-poll fetch mock (which asserts an exact sequence of
// /budget responses) nor lands a state update outside act(); this suite asserts
// the credit figure, not the greeting.
vi.mock("@/lib/credit-welcome", () => ({
  claimCreditWelcomeFirstView: vi.fn(
    () => new Promise<import("@/lib/credit-welcome").CreditWelcomeClaim>(() => {})
  )
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The poll payload the /budget route returns (the org credit counters). */
function budget(billable: number, granted: number) {
  return Response.json({
    budget: {
      spend_usd: billable,
      billable_spend_usd: billable,
      credit_granted_usd: granted,
      credit_balance_usd: granted - billable
    }
  });
}

describe("SidebarCreditAmount", () => {
  it("shows the remaining credit as one compact figure (no meter, no 'left')", () => {
    render(<SidebarCreditAmount billableUsd={12.5} grantedUsd={20} orgSlug="org-1" />);

    expect(screen.getByText("$7.50")).toBeInTheDocument();
    // The standalone meter's bar and its "left" suffix are gone.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  it("shows an overdrawn balance honestly instead of clamping to zero", () => {
    render(<SidebarCreditAmount billableUsd={25} grantedUsd={20} orgSlug="org-1" />);

    expect(screen.getByText("-$5.00")).toBeInTheDocument();
  });

  it("renders nothing when the credit fields are unavailable (deployment skew)", () => {
    const { container } = render(<SidebarCreditAmount orgSlug="org-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("polls the lightweight budget endpoint and updates as spend accrues", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(budget(2.5, 20)).mockResolvedValueOnce(budget(3.75, 20));
    render(<SidebarCreditAmount billableUsd={1} grantedUsd={20} orgSlug="org-1" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("$17.50")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText("$16.25")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/orgs/org-1/budget", {
      cache: "no-store"
    });
  });

  it("ignores an older poll that resolves after a newer spend value", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveSecond = resolve)));
    render(<SidebarCreditAmount billableUsd={1} grantedUsd={20} orgSlug="org-1" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      resolveSecond(budget(3.75, 20));
    });
    expect(screen.getByText("$16.25")).toBeInTheDocument();

    await act(async () => {
      resolveFirst(budget(2.5, 20));
    });
    expect(screen.getByText("$16.25")).toBeInTheDocument();
  });
});
