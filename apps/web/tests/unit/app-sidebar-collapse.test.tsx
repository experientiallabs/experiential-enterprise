import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar's collapse preference persists in a cookie the server reads, so
// a reload paints the rail at its remembered width instead of forgetting the
// choice and snapping 208px -> 64px after hydration (the product owner, 2026-07-30). The
// old narrow-viewport auto-collapse heuristic is gone: below the breakpoint
// the rail reflows into a top bar, so there is no viewport left for it.
vi.mock("next/navigation", () => ({ usePathname: () => "/models" }));
vi.mock("@/components/shell/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/components/shell/SignOutButton", () => ({ SignOutButton: () => null }));
vi.mock("@/components/auth/login-modal-context", () => ({
  useLoginModal: () => ({ open: vi.fn(), requireAuth: vi.fn() })
}));

import { AppSidebar } from "@/components/shell/AppSidebar";
import {
  parseSidebarCollapse,
  SIDEBAR_COLLAPSE_COOKIE
} from "@/components/shell/sidebar-collapse";
import type { Org } from "@/lib/types";

const org = { id: "org-1", slug: "acme", name: "Acme" } as Org;

function renderSidebar(initialCollapsed: boolean | null) {
  return render(
    <AppSidebar
      session={{
        orgs: [org],
        currentOrg: org,
        userEmail: "member@example.test",
        showAdminPanel: false
      }}
      initialCollapsed={initialCollapsed}
    />
  );
}

beforeEach(() => {
  document.cookie = `${SIDEBAR_COLLAPSE_COOKIE}=; path=/; max-age=0`;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sidebar collapse persistence", () => {
  it("renders collapsed on first paint when the cookie says so", () => {
    renderSidebar(true);
    // Collapsed rail: the toggle offers to expand, and nav labels are icons only.
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("renders expanded when the visitor never chose", () => {
    renderSidebar(null);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it("writes the preference cookie when toggled", () => {
    renderSidebar(null);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(parseSidebarCollapse(readCookie(SIDEBAR_COLLAPSE_COOKIE))).toBe(true);
  });
});

describe("sidebar collapse cookie parsing", () => {
  it("maps values to a tri-state preference", () => {
    expect(parseSidebarCollapse("1")).toBe(true);
    expect(parseSidebarCollapse("0")).toBe(false);
    expect(parseSidebarCollapse(undefined)).toBeNull();
    expect(parseSidebarCollapse("weird")).toBeNull();
  });
});

function readCookie(name: string): string | undefined {
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`))
    ?.split("=")[1];
}
