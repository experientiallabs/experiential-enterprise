import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import { loadOrgShell } from "@/lib/data-cache";
import { DataSourceNotFoundError } from "@/lib/errors";

import { AppSidebar } from "./AppSidebar";
import { parseSidebarCollapse, SIDEBAR_COLLAPSE_COOKIE } from "./sidebar-collapse";

type AppShellSidebarProps = {
  orgSlug: string;
};

/**
 * Async server component that resolves the member sidebar packet. Rendered
 * inside a Suspense boundary in the org layout so its data fetches stream
 * behind a skeleton instead of blocking the rest of the route. The signed-out
 * rail needs no data, so the layout renders AppSidebar with a null session
 * directly.
 */
export async function AppShellSidebar({ orgSlug }: AppShellSidebarProps) {
  try {
    const user = await requireAuthenticatedUser();
    const [shell, platformAdmin, jar] = await Promise.all([
      loadOrgShell(orgSlug),
      isPlatformAdmin(),
      cookies()
    ]);
    return (
      <AppSidebar
        session={{
          currentOrg: shell.currentOrg,
          orgs: shell.orgs,
          userEmail: user.email ?? "Signed in",
          showAdminPanel: platformAdmin
        }}
        // Server-rendered so the rail paints at its remembered width instead
        // of snapping after hydration.
        initialCollapsed={parseSidebarCollapse(jar.get(SIDEBAR_COLLAPSE_COOKIE)?.value)}
      />
    );
  } catch (error) {
    if (error instanceof DataSourceNotFoundError) {
      notFound();
    }
    throw error;
  }
}

// The old serves-traffic probe that gated the Telemetry nav entry is gone
// (the product owner, 2026-07-30, reversing the 2026-07-23 decision): the entry always
// renders and the page owns its never-served state.
