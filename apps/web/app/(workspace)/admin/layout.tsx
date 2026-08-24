import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { AdminSectionTabs } from "@/components/admin/AdminSectionTabs";
import { requirePlatformAdmin } from "@/lib/auth/admin";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { signinPath } from "@/lib/routes";
import { DataSourceNotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

// This is a site-level control plane, not an organization-admin surface.
// Render it as not-found for every signed-in user who is not a platform
// operator so neither the navigation nor a guessed URL exposes it.
//
// The workspace shell comes from the (workspace) group layout; when this
// segment carried its own AppShell, every trip into or out of /admin
// remounted the shell and flashed the sidebar skeleton, and the sidebar
// silently switched to the operator's first org instead of the active one
// (the product owner, 2026-07-30). This layout is the gate plus the section chrome:
// the eyebrow and section tabs live here so switching sections swaps only
// the body below them.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect(`${signinPath()}?next=/admin`);
  }
  try {
    await requirePlatformAdmin();
  } catch (error) {
    if (error instanceof DataSourceNotFoundError) {
      notFound();
    }
    throw error;
  }

  return (
    // min-h-full (not h-full): every admin section grows with its content, and
    // a page taller than the viewport would overflow an h-full box and swallow
    // the shell <main>'s bottom padding — so the layout grows instead and
    // carries its own bottom padding, mirroring the shell's clamp (AppShell.tsx).
    <div className="flex min-h-full w-full flex-col gap-5 page-bottom-pad">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-[11px] font-semibold uppercase text-muted-2">Experiential admin</p>
        <AdminSectionTabs />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
