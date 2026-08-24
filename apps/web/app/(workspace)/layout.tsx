import { Suspense, type ReactNode } from "react";
import { cookies } from "next/headers";

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { AppShell } from "@/components/shell/AppShell";
import { AppShellSidebar } from "@/components/shell/AppShellSidebar";
import { AppSidebar } from "@/components/shell/AppSidebar";
import { AppSidebarSkeleton } from "@/components/shell/AppSidebarSkeleton";
import {
  parseSidebarCollapse,
  SIDEBAR_COLLAPSE_COOKIE
} from "@/components/shell/sidebar-collapse";
import { WelcomeTrigger } from "@/components/shell/WelcomeTrigger";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";

export const dynamic = "force-dynamic";

type WorkspaceLayoutProps = {
  children: ReactNode;
};

/**
 * The one shell for every sidebar surface: /models, /playground, /telemetry,
 * /credits, /settings. The shell must mount in this single group layout and
 * nowhere below it; when segments carried their own AppShell, every sidebar
 * click crossed a layout boundary, remounted the shell, and flashed the sidebar
 * skeleton even though nothing in the sidebar changed (the product owner, 2026-07-30).
 *
 * One sidebar serves both audiences (gw-shell P3); the audience branches here
 * only over the session data: a signed-out visitor gets the rail with a null
 * session (no org fetches), a member gets it with their active org's packet.
 * Each page re-derives the audience itself because Next.js does not guarantee
 * this layout re-runs for every RSC request.
 */
export default async function WorkspaceLayout({ children }: WorkspaceLayoutProps) {
  // Base URLs for the login modal's success-step onboarding prompts, resolved
  // server-side through the same deployment-aware resolvers /llms.txt and the
  // connect-traces page use (hosted platform by default, the deployment's own
  // URL when EXPLABS_PUBLIC_BACKEND_URL / EXPLABS_WEBAPP_URL are set).
  const apiBaseUrl = publicServingBaseUrl();
  const webBaseUrl = process.env.EXPLABS_WEBAPP_URL ?? PLATFORM_WEB_URL;
  const user = await getAuthenticatedUser();
  if (user === null) {
    const jar = await cookies();
    return (
      <LoginModalProvider isAuthenticated={false} webBaseUrl={webBaseUrl} apiBaseUrl={apiBaseUrl}>
        <AppShell
          sidebar={
            <AppSidebar
              session={null}
              initialCollapsed={parseSidebarCollapse(jar.get(SIDEBAR_COLLAPSE_COOKIE)?.value)}
            />
          }
        >
          {children}
        </AppShell>
      </LoginModalProvider>
    );
  }
  const org = await resolveActiveOrg();
  return (
    <LoginModalProvider isAuthenticated webBaseUrl={webBaseUrl} apiBaseUrl={apiBaseUrl}>
      <AppShell
        sidebar={
          <Suspense fallback={<AppSidebarSkeleton />}>
            <AppShellSidebar orgSlug={org.slug} />
          </Suspense>
        }
      >
        {children}
      </AppShell>
      <WelcomeTrigger activeOrgId={org.id} webBaseUrl={webBaseUrl} apiBaseUrl={apiBaseUrl} />
    </LoginModalProvider>
  );
}
