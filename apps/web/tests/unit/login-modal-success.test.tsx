// The success step is the one-time first-key reveal. Its DURABLE first-time
// signal is a freshly MINTED secret (a key is minted only when the org has
// none): it shows exactly once, when the initial key is created, and never
// again on a later login, an OAuth return (?welcome=1), or a refresh, because
// every later /api/welcome read returns an existing keyPrefix with no mint. A
// transient null (the new membership is not yet RLS-visible) is retried.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/models";
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams
}));

const fetchWelcomeData = vi.fn();
vi.mock("@/components/auth/welcome-data", () => ({
  fetchWelcomeData: () => fetchWelcomeData()
}));

import { LoginModal } from "@/components/auth/LoginModal";

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true
  });
});

afterEach(() => {
  vi.clearAllMocks();
  pathname = "/models";
  searchParams = new URLSearchParams();
});

type RenderProps = {
  onClose?: () => void;
  onWelcomeLoaded?: () => void;
};

function renderSuccess({ onClose = vi.fn(), onWelcomeLoaded = vi.fn() }: RenderProps = {}) {
  render(
    <LoginModal
      step="success"
      onAuthSuccess={vi.fn()}
      onClose={onClose}
      webBaseUrl="https://web.test"
      apiBaseUrl="https://api.test"
      onWelcomeLoaded={onWelcomeLoaded}
    />
  );
  return { onClose, onWelcomeLoaded };
}

const MINTED = `xpl_${"a".repeat(40)}`;

describe("login modal first-key reveal", () => {
  it("shows once on the initial mint and offers copy for the freshly minted secret", async () => {
    fetchWelcomeData.mockResolvedValue({ mintedSecret: MINTED, keyPrefix: null, grantedUsd: 20 });

    renderSuccess();

    const success = await screen.findByTestId("login-success-step");
    await waitFor(() => expect(success.querySelector("code")).toHaveTextContent(/^xpl_a{40}$/));
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeInTheDocument();
    expect(screen.getByText("This key won't be shown again. Copy it now.")).toBeInTheDocument();
  });

  it("puts the $20 free credits front and center alongside the confetti and key", async () => {
    fetchWelcomeData.mockResolvedValue({ mintedSecret: MINTED, keyPrefix: null, grantedUsd: 20 });

    renderSuccess();

    const hero = await screen.findByTestId("welcome-credits-line");
    expect(hero).toHaveTextContent("$20");
    expect(hero).toHaveTextContent("in free credits");
    // The copyable key is still shown together with the credits hero.
    expect(screen.getByRole("button", { name: "Copy API key" })).toBeInTheDocument();
    expect(screen.getByText(MINTED)).toBeInTheDocument();
  });

  it("never shows again once the org already has a key (later login / ?welcome=1 / refresh)", async () => {
    // No mint happens: the org already holds a key, so the read returns its
    // recognition prefix. The reveal must not appear at all, and must close.
    fetchWelcomeData.mockResolvedValue({
      mintedSecret: null,
      keyPrefix: "xpl_ab12cd34",
      grantedUsd: 20
    });
    const { onClose } = renderSuccess();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("login-success-step")).not.toBeInTheDocument();
    expect(screen.queryByText(/xpl_ab12cd34/)).not.toBeInTheDocument();
  });

  it("retries a transient null and reveals once the initial key mints", async () => {
    fetchWelcomeData
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ mintedSecret: MINTED, keyPrefix: null, grantedUsd: 20 });
    const { onClose } = renderSuccess();

    expect(await screen.findByTestId("login-success-step")).toBeInTheDocument();
    expect(fetchWelcomeData.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retries a transient mint failure (keyless, no prefix) instead of skipping the reveal", async () => {
    // A keyless summary whose /api/keys mint transiently failed returns both
    // mintedSecret and keyPrefix null. That must be retried, not mistaken for
    // an existing key, so a flaky mint never permanently skips the reveal.
    fetchWelcomeData
      .mockResolvedValueOnce({
        mintedSecret: null,
        keyPrefix: null,
        grantedUsd: 20,
        canManageKeys: true
      })
      .mockResolvedValue({ mintedSecret: MINTED, keyPrefix: null, grantedUsd: 20 });
    const { onClose } = renderSuccess();

    expect(await screen.findByTestId("login-success-step")).toBeInTheDocument();
    expect(fetchWelcomeData.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes for a non-admin member who cannot mint, instead of polling forever", async () => {
    // Keyless and not mintable: no first-key reveal can ever be produced, so
    // the step closes immediately rather than spin.
    fetchWelcomeData.mockResolvedValue({
      mintedSecret: null,
      keyPrefix: null,
      grantedUsd: 20,
      canManageKeys: false
    });
    const { onClose } = renderSuccess();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId("login-success-step")).not.toBeInTheDocument();
    expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
  });

  it("on a slow mint or read, keeps polling without revealing a keyless modal or closing", async () => {
    // Whether the summary is unreadable (null) or readable-but-keyless (the mint
    // is stuck), the reveal must never terminally close a first-time signup and
    // must never show a keyless modal a ?welcome=1 marker could replay. It only
    // ever shows a real minted key, so it keeps polling until the mint lands.
    const stuckReads = [null, { mintedSecret: null, keyPrefix: null, grantedUsd: 20, canManageKeys: true }];
    for (const stuck of stuckReads) {
      vi.useFakeTimers();
      try {
        fetchWelcomeData.mockReset();
        fetchWelcomeData.mockResolvedValue(stuck);
        const { onClose } = renderSuccess();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(20000);
        });

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.queryByTestId("login-success-step")).not.toBeInTheDocument();
        expect(screen.queryByTestId("login-modal")).not.toBeInTheDocument();
        // Still polling well past the fast budget, not stopped.
        expect(fetchWelcomeData.mock.calls.length).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
        cleanup();
      }
    }
  });

  it("renders all three coding-agent prompts with copy actions", async () => {
    fetchWelcomeData.mockResolvedValue({ mintedSecret: MINTED, keyPrefix: null, grantedUsd: 20 });

    renderSuccess();

    await screen.findByTestId("login-success-step");
    const startChatting = screen.getByRole("button", { name: "Copy Start chatting prompt" });
    expect(startChatting).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Upload my traces prompt" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Connect my provider keys prompt" })
    ).toBeInTheDocument();

    startChatting.click();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain("/v1/models");
  });

  it("refreshes the server tree once the reveal loads", async () => {
    fetchWelcomeData.mockResolvedValue({ mintedSecret: MINTED, keyPrefix: null, grantedUsd: 20 });
    const { onWelcomeLoaded } = renderSuccess();

    await waitFor(() => expect(onWelcomeLoaded).toHaveBeenCalledTimes(1));
  });
});
