import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/api-keys",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { LockedSection } from "@/components/settings/LockedSection";

describe("LockedSection", () => {
  it("says what lives here and opens the login modal, never a navigation", () => {
    render(
      <LoginModalProvider isAuthenticated={false}>
        <LockedSection description="API keys for calling the gateway." />
      </LoginModalProvider>
    );

    expect(screen.getByText("API keys for calling the gateway.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByTestId("login-modal")).toBeInTheDocument();
  });
});
