import { fireEvent, render as renderBare, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { CreditAccountsSection } from "@/components/keys/overview-sections";

// The shell calls useLoginModal, so it mounts under the provider the
// workspace layout supplies; `isAuthenticated` drives the gate.
function render(ui: Parameters<typeof renderBare>[0], isAuthenticated = true) {
  return renderBare(<LoginModalProvider isAuthenticated={isAuthenticated}>{ui}</LoginModalProvider>);
}

// The exported Overview shell: its real internals are keys-P8. This test pins
// the mount contract — one-line mountable, signed-out renders with a login
// prompt, no data fetches — so the consuming workstream can place it today.
// (UseViaKeyCard graduated from a shell to its real internals in keys-P7;
// its contract lives in use-via-key-card.test.tsx.)

describe("CreditAccountsSection (keys-P8 shell)", () => {
  it("mounts self-contained and prompts login signed out", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CreditAccountsSection orgId={null} />, false);
    expect(screen.getByTestId("credit-accounts-section")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to see your credits" }));
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
