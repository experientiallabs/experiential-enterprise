import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VerifyEmailBanner } from "@/components/auth/VerifyEmailBanner";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("VerifyEmailBanner", () => {
  it("tells the user credits are locked until they verify, and names the address", () => {
    render(<VerifyEmailBanner email="founder@company.com" />);
    expect(screen.getByText(/Verify your email to use your credits/i)).toBeInTheDocument();
    expect(screen.getByText(/founder@company.com/)).toBeInTheDocument();
  });

  it("stays tasteful: no em dash and no bottom border (the product owner, 2026-08-22)", () => {
    const { container } = render(<VerifyEmailBanner email="founder@company.com" />);
    expect(container.textContent).not.toContain("—");
    expect(container.firstElementChild?.className).not.toContain("border-b");
  });

  it("resends the verification link through the resend endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<VerifyEmailBanner email="founder@company.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Resend link" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/auth/resend-verification",
        expect.objectContaining({ method: "POST" })
      )
    );
    expect(await screen.findByRole("button", { name: "Link resent" })).toBeInTheDocument();
  });
});
