import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditsWelcome } from "@/components/shell/CreditsWelcome";
import { claimCreditWelcomeFirstView } from "@/lib/credit-welcome";

// The signup-credit greeting: pops up beside the credits meter, holds, and
// fades on its own the FIRST time the user opens the workspace, then never
// again (the product owner, 2026-08-21). Its memory is a durable per-user flag on the
// server whose claim is atomic and server-arbitrated: exactly one caller wins
// firstView, so two tabs or devices opened at once cannot each greet, and the
// claim is deferred until the bubble is actually renderable so it is never
// spent while hidden. The ANNOUNCED amount is the launch-grant EVENT amount
// the claim carries, never the meter's cumulative counter (which also counts
// top-ups — the "$776 in credits added" bug on the seeded demo org).

vi.mock("@/lib/credit-welcome", () => ({
  claimCreditWelcomeFirstView: vi.fn()
}));

const claim = vi.mocked(claimCreditWelcomeFirstView);

function bubbles(): HTMLElement[] {
  return screen.queryAllByTestId("credits-welcome-bubble");
}

function bubble(): HTMLElement | null {
  return bubbles()[0] ?? null;
}

/** Let the claim promise resolve and its state update flush. */
async function settleClaim(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** A matchMedia whose query never matches, i.e. below the bubble's breakpoint. */
function stubNarrowViewport(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}

describe("CreditsWelcome", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default: a wide viewport and this caller wins the atomic claim of a
    // standard $20 welcome grant.
    claim.mockResolvedValue({ firstView: true, welcomeGrantUsd: 20 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("greets on the winning claim with the grant-event amount, holds, then fades", async () => {
    render(
      <CreditsWelcome granted={20}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()).not.toBeNull();
    expect(bubble()?.textContent).toContain("$20 in credits added to your account");

    // The hold elapses: the bubble starts its slow fade rather than snapping away.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(bubble()).not.toBeNull();
    expect(bubble()?.className).toContain("opacity-0");

    // The fade completes: gone.
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(bubble()).toBeNull();
  });

  it("announces the grant EVENT amount, never the meter's cumulative total", async () => {
    // Regression (the product owner, 2026-08-22, main-preview): the seeded YC demo org's
    // meter showed credit_granted_usd = 776 ($526 YC grant + $250 of Stripe
    // top-ups) and the bubble announced "$776 in credits added". The meter
    // figure gates only WHEN to claim; the claim's launch-grant amount is what
    // gets said.
    claim.mockResolvedValue({ firstView: true, welcomeGrantUsd: 526 });

    render(
      <CreditsWelcome granted={776}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()?.textContent).toContain("$526 in credits added to your account");
    expect(bubble()?.textContent).not.toContain("776");
  });

  it("claims exactly once on the first render", async () => {
    render(
      <CreditsWelcome granted={20}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the claim wins but carries no announceable amount", async () => {
    // A won claim with an unreadable grant must not render "$null"; the server
    // avoids spending the claim on this, and the bubble degrades silently.
    claim.mockResolvedValue({ firstView: true, welcomeGrantUsd: null });

    render(
      <CreditsWelcome granted={20}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()).toBeNull();
  });

  it("stays silent when it loses the claim to a concurrent tab or a past visit", async () => {
    // The server already gave firstView to someone else; this caller must not
    // greet on a local guess.
    claim.mockResolvedValue({ firstView: false, welcomeGrantUsd: 20 });

    render(
      <CreditsWelcome granted={20}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()).toBeNull();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("greets from only one of two simultaneous opens (concurrent-read safety)", async () => {
    // The atomic server claim hands firstView to exactly one caller; the other
    // loses the primary-key race. Two tabs opened at once must not both greet.
    claim
      .mockResolvedValueOnce({ firstView: true, welcomeGrantUsd: 20 })
      .mockResolvedValueOnce({ firstView: false, welcomeGrantUsd: 20 });

    render(
      <div>
        <CreditsWelcome granted={20}>
          <span>tab-a</span>
        </CreditsWelcome>
        <CreditsWelcome granted={20}>
          <span>tab-b</span>
        </CreditsWelcome>
      </div>
    );
    await settleClaim();

    expect(claim).toHaveBeenCalledTimes(2);
    expect(bubbles()).toHaveLength(1);
  });

  it("does not spend the claim while the meter and bubble are responsively hidden", async () => {
    // At or below the breakpoint the credit meter and bubble are display:none;
    // claiming here would burn a greeting the user never sees.
    stubNarrowViewport();

    render(
      <CreditsWelcome granted={20}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it("never announces a zero grant and never claims for it", async () => {
    render(
      <CreditsWelcome granted={0}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });

  it("waits for the grant before claiming", async () => {
    render(
      <CreditsWelcome granted={null}>
        <span>meter</span>
      </CreditsWelcome>
    );
    await settleClaim();

    expect(bubble()).toBeNull();
    expect(claim).not.toHaveBeenCalled();
  });
});
