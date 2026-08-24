import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutoRechargeCard } from "@/components/billing/AutoRechargeCard";
import { CreditHistory } from "@/components/billing/CreditHistory";
import { SpendAlertsCard } from "@/components/billing/SpendAlertsCard";

// Each card fetches on mount; a fetch that never resolves pins the component in
// its loading state so the skeleton it shows can be asserted. Every async
// section on /credits must render a shaped skeleton, not a bare "Loading…" or an
// empty gap that shifts when the data lands (the product owner, ux-polish audit).
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPendingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {}))
  );
}

describe("credits section loading skeletons", () => {
  it("credit history shows a table skeleton while the ledger loads", () => {
    stubPendingFetch();
    render(<CreditHistory orgId="org-1" />);
    expect(screen.getByTestId("credit-history-loading")).toBeInTheDocument();
    // Not the old bare text.
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("auto-recharge shows a card skeleton instead of collapsing to nothing", () => {
    stubPendingFetch();
    render(<AutoRechargeCard orgId="org-1" />);
    expect(screen.getByTestId("auto-recharge-loading")).toBeInTheDocument();
  });

  it("spend alerts shows a rule-list skeleton while rules load", () => {
    stubPendingFetch();
    render(<SpendAlertsCard canManage orgId="org-1" />);
    expect(screen.getByTestId("spend-alerts-loading")).toBeInTheDocument();
    expect(screen.queryByText("Loading alerts…")).not.toBeInTheDocument();
  });
});
