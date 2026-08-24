import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const open = vi.fn();
vi.mock("@/components/auth/login-modal-context", () => ({
  useLoginModal: () => ({ open, requireAuth: (fn: () => void) => fn() })
}));

import { DemoBanner } from "@/components/telemetry-page/demo-banner";

describe("DemoBanner", () => {
  it("shows the Demo data chip and routes the CTA through the login modal", () => {
    render(<DemoBanner />);
    expect(screen.getByText("Demo data")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log in to see your usage" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
