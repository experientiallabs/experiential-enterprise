import { beforeEach, describe, expect, it, vi } from "vitest";

// Settings sections are workspace-private (main's proxy bounces a signed-out
// visitor to /signin before the page renders), so there is no signed-out
// "locked card" branch to test — the pages require an authenticated member.
// What remains section-specific here: the retired section URLs redirect into
// the merged IA (credits/settings redesign 2026-08-22) — Providers and
// Observability (and the older Integrations name) land on Connections,
// carrying ?returnTo through, and Identities & access lands on the top-level
// Access control page at /aliases.

const redirect = vi.hoisted(() =>
  vi.fn((target: string): never => {
    throw new Error(`redirect:${target}`);
  })
);
vi.mock("next/navigation", () => ({
  redirect,
  usePathname: () => "/settings/connections",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import LegacyIdentitiesSettingsPage from "@/app/(workspace)/settings/identities/page";
import LegacyIntegrationsSettingsPage from "@/app/(workspace)/settings/integrations/page";
import LegacyObservabilitySettingsPage from "@/app/(workspace)/settings/observability/page";
import LegacyProvidersSettingsPage from "@/app/(workspace)/settings/providers/page";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("retired settings-section redirects", () => {
  it("/settings/integrations lands on connections, carrying returnTo through", async () => {
    await LegacyIntegrationsSettingsPage({
      searchParams: Promise.resolve({ returnTo: "/projects/support-router" })
    }).catch(() => {
      // The redirect mock throws by design.
    });
    expect(redirect).toHaveBeenCalledWith(
      "/settings/connections?returnTo=%2Fprojects%2Fsupport-router"
    );
  });

  it("/settings/observability lands on connections, carrying returnTo through", async () => {
    await LegacyObservabilitySettingsPage({
      searchParams: Promise.resolve({ returnTo: "/projects/support-router" })
    }).catch(() => {
      // The redirect mock throws by design.
    });
    expect(redirect).toHaveBeenCalledWith(
      "/settings/connections?returnTo=%2Fprojects%2Fsupport-router"
    );
  });

  it("/settings/observability lands on connections bare when no returnTo rides along", async () => {
    await LegacyObservabilitySettingsPage({ searchParams: Promise.resolve({}) }).catch(() => {
      // The redirect mock throws by design.
    });
    expect(redirect).toHaveBeenCalledWith("/settings/connections");
  });

  it("/settings/providers lands on connections", () => {
    try {
      LegacyProvidersSettingsPage();
    } catch {
      // The redirect mock throws by design.
    }
    expect(redirect).toHaveBeenCalledWith("/settings/connections");
  });

  it("/settings/identities lands on the top-level Access control page", () => {
    try {
      LegacyIdentitiesSettingsPage();
    } catch {
      // The redirect mock throws by design.
    }
    expect(redirect).toHaveBeenCalledWith("/aliases");
  });
});
