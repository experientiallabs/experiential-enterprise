import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings/providers" }));

import { SettingsNav } from "@/components/settings/SettingsNav";

const GATED_LABELS = ["Domains & SSO", "SCIM provisioning", "Provider policy", "Audit log", "Teams"];

function navLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((link) => link.textContent ?? "");
}

describe("SettingsNav enterprise gating", () => {
  it("renders the gated entries when their capabilities are available", () => {
    const { container } = render(<SettingsNav showAuditLog showDataControls showScim showSso showTeams />);
    const labels = navLabels(container);
    for (const label of GATED_LABELS) {
      expect(labels).toContain(label);
    }
  });

  it("renders NOTHING for gated entries when not available — absent, not locked", () => {
    const { container } = render(
      <SettingsNav showAuditLog={false} showDataControls={false} showScim={false} showSso={false} showTeams={false} />
    );
    const labels = navLabels(container);
    for (const label of GATED_LABELS) {
      expect(labels).not.toContain(label);
    }
    // The neighbors stay: the entries disappear without leaving upsell chrome,
    // a lock icon, or a disabled placeholder behind.
    expect(labels).toContain("Members");
    expect(labels).toContain("Organization");
    expect(labels).toContain("Account");
    expect(container.textContent).not.toMatch(/upgrade|enterprise|lock/i);
  });

  it("gates each entry independently", () => {
    const { container } = render(<SettingsNav showAuditLog={false} showDataControls={false} showScim={false} showSso showTeams={false} />);
    const labels = navLabels(container);
    expect(labels).toContain("Domains & SSO");
    expect(labels).not.toContain("Audit log");
    expect(labels).not.toContain("Teams");
  });
});
