import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The app shell (sidebar included) must mount exactly once, in the (workspace)
// group layout. When child pages carried their own AppShell, every
// sidebar click crossed a layout boundary, remounted the shell, and flashed the
// sidebar skeleton even though the sidebar itself had not changed (the product owner,
// 2026-07-30). This suite pins both halves of the fix: the group layout serves
// both audiences, and no segment below it renders its own shell.
const getAuthenticatedUser = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
// The signed-out branch reads the collapse cookie so the rail paints at its
// remembered width; outside a request there is no jar to read.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import WorkspaceLayout from "@/app/(workspace)/layout";
import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { AppShell } from "@/components/shell/AppShell";
import { AppShellSidebar } from "@/components/shell/AppShellSidebar";
import { AppSidebar } from "@/components/shell/AppSidebar";
import { WelcomeTrigger } from "@/components/shell/WelcomeTrigger";

beforeEach(() => {
  vi.clearAllMocks();
  resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "acme" });
});

describe("workspace group layout owns the shell for both audiences", () => {
  it("gives a signed-out visitor the same sidebar with a null session, without resolving an org", async () => {
    getAuthenticatedUser.mockResolvedValue(null);

    const rendered = await WorkspaceLayout({ children: "page" });

    // The login-modal provider wraps the shell so every surface can gate
    // through useLoginModal; the audience prop is the server's derivation.
    expect(rendered.type).toBe(LoginModalProvider);
    expect(rendered.props.isAuthenticated).toBe(false);
    const shell = rendered.props.children;
    expect(shell.type).toBe(AppShell);
    // One sidebar for every visitor (gw-shell P3): signed out it mounts
    // directly (no data to stream), with session null.
    expect(shell.props.sidebar.type).toBe(AppSidebar);
    expect(shell.props.sidebar.props.session).toBeNull();
    expect(resolveActiveOrg).not.toHaveBeenCalled();
  });

  it("gives a member the workspace sidebar for their active org, behind Suspense", async () => {
    getAuthenticatedUser.mockResolvedValue({ id: "u1" });

    const rendered = await WorkspaceLayout({ children: "page" });

    expect(rendered.type).toBe(LoginModalProvider);
    expect(rendered.props.isAuthenticated).toBe(true);
    // Signed in, the provider wraps the shell plus the re-triggerable welcome
    // celebration overlay (a sibling), so children is an array.
    const children = Array.isArray(rendered.props.children)
      ? rendered.props.children
      : [rendered.props.children];
    const shell = children.find((child: { type: unknown }) => child.type === AppShell);
    expect(shell.type).toBe(AppShell);
    const sidebar = shell.props.sidebar;
    expect(sidebar.type).toBe(Suspense);
    expect(sidebar.props.children.type).toBe(AppShellSidebar);
    expect(sidebar.props.children.props.orgSlug).toBe("acme");
    // The welcome-celebration overlay is keyed on the active org id so a soft
    // org-switch re-checks the new org's trigger without a hard reload.
    const welcome = children.find((child: { type: unknown }) => child.type === WelcomeTrigger);
    expect(welcome.props.activeOrgId).toBe("org-1");
  });
});

describe("no segment outside the group layout mounts its own shell", () => {
  const appDir = join(__dirname, "..", "..", "app");
  const groupDir = join(appDir, "(workspace)");

  function routeFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return routeFilesUnder(full);
      }
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("keeps every sidebar surface inside the (workspace) group", () => {
    // Outside the group each would carry its own layout, and navigating to
    // them would remount the shell. /admin was missed by the first version of
    // this test because it only scanned the group (the product owner, 2026-07-30).
    const files = routeFilesUnder(groupDir);
    for (const surface of ["models", "admin"]) {
      expect(files.some((file) => file.endsWith(join(surface, "page.tsx")))).toBe(true);
    }
  });

  it("renders AppShell in the group layout and nowhere else under app/", () => {
    const groupLayout = join(groupDir, "layout.tsx");
    const offenders = routeFilesUnder(appDir).filter((file) => {
      if (file === groupLayout) {
        return false;
      }
      return readFileSync(file, "utf8").includes("components/shell/AppShell");
    });
    expect(offenders).toEqual([]);
  });
});
