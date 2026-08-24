import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The final settings IA (credits/settings redesign 2026-08-22): exactly four
// sections. Providers and Observability merged into Connections; Identities &
// access moved out to the top-level Access control page (/aliases); API keys,
// aliases, and credits are all first-class top-level pages. This pin keeps a retired
// section from drifting back into the rail.
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/connections" }));

import { SettingsNav } from "@/components/settings/SettingsNav";

describe("SettingsNav", () => {
  it("shows exactly Connections, Members, Organization, Account, in order", () => {
    render(<SettingsNav showAuditLog={false} showDataControls={false} showScim={false} showSso={false} showTeams={false} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((link) => link.textContent)).toEqual([
      "Connections",
      "Members",
      "Organization",
      "Account"
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/connections",
      "/settings/members",
      "/settings/organization",
      "/settings/account"
    ]);
  });

  it("marks the current section active", () => {
    render(<SettingsNav showAuditLog={false} showDataControls={false} showScim={false} showSso={false} showTeams={false} />);
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });
});
