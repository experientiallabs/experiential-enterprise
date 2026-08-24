import { redirect } from "next/navigation";

import { aliasesPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * Identities & access folded into the top-level Access control page at
 * /aliases (credits/settings redesign 2026-08-22; renamed from "Aliases &
 * access" 2026-08-23): the identities/grants/budgets panel now lives beside
 * the named aliases it governs, first-class instead of buried in settings.
 * Old links land there.
 */
export default function LegacyIdentitiesSettingsPage() {
  redirect(aliasesPath());
}
