import type { ReactNode } from "react";

import { DocsShell } from "@/components/docs/DocsShell";
import { DOCS_THEME_BOOT_SCRIPT, DOCS_THEME_ROOT_ID } from "@/components/docs/docs-theme";
import { getAuthenticatedUser } from "@/lib/auth/server";

import "./docs.css";

// The docs section's own layout: public (the proxy exempts the whole /docs
// prefix), outside the workspace shell, and the only place [data-docs-theme]
// exists — the dark/light toggle is a docs feature, not an app one. The boot
// script must be the root's first child so a stored dark preference applies
// before first paint.

export const dynamic = "force-dynamic";

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const user = await getAuthenticatedUser();
  return (
    <div
      className="min-h-dvh w-full bg-background text-ink"
      data-docs-theme="light"
      id={DOCS_THEME_ROOT_ID}
      // The boot script flips this attribute to a stored "dark" before React
      // hydrates; that divergence is the design, not a bug to reconcile.
      suppressHydrationWarning
    >
      <script dangerouslySetInnerHTML={{ __html: DOCS_THEME_BOOT_SCRIPT }} />
      <DocsShell signedIn={user !== null}>{children}</DocsShell>
    </div>
  );
}
