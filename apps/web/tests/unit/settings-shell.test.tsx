import { existsSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The settings header and tab bar must stay mounted while a section loads.
// Without a loading.tsx at the settings segment, the nearest Suspense boundary
// for a section navigation is the group-level one, which sits ABOVE
// settings/layout.tsx - so clicking a settings tab replaced the tab bar itself
// with the route skeleton, then repainted it byte-identical (the product owner,
// 2026-07-30). Final IA: the sidebar entry points at /settings itself, which
// lands on the first section (Connections).
vi.mock("next/navigation", () => ({ usePathname: () => "/settings/connections" }));
// The switcher and sign-out button pull router/auth machinery irrelevant here.
vi.mock("@/components/shell/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/components/shell/SignOutButton", () => ({ SignOutButton: () => null }));
vi.mock("@/components/auth/login-modal-context", () => ({
  useLoginModal: () => ({ open: vi.fn(), requireAuth: vi.fn() })
}));

import SettingsSectionLoading from "@/app/(workspace)/settings/loading";
import { AppSidebar } from "@/components/shell/AppSidebar";
import type { Org } from "@/lib/types";
import { settingsPath } from "@/lib/routes";

const org = { id: "org-1", slug: "acme", name: "Acme" } as Org;

function stubBrowserApis() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  );
}

describe("settings section boundary", () => {
  it("keeps a loading fallback at the settings segment so the tab bar stays mounted", () => {
    const settingsDir = join(__dirname, "..", "..", "app", "(workspace)", "settings");
    expect(existsSync(join(settingsDir, "loading.tsx"))).toBe(true);

    const { container } = render(<SettingsSectionLoading />);
    // Body-shaped placeholder only: no heading, no nav - those live in the
    // layout above and must not be duplicated by the fallback.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("nav")).toBeNull();
  });

  it("links the sidebar Settings entry to /settings, still active across all sections", () => {
    stubBrowserApis();
    try {
      const { container } = render(
        <AppSidebar
          session={{
            orgs: [org],
            currentOrg: org,
            userEmail: "member@example.test",
            showAdminPanel: false
          }}
        />
      );
      const link = container.querySelector('a[aria-label="Settings"]');
      expect(link?.getAttribute("href")).toBe(settingsPath());
      // activePrefix keeps the entry highlighted on any /settings section.
      expect(link?.className).toContain("text-accent");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
