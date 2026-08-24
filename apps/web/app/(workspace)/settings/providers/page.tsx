import { redirect } from "next/navigation";

import { connectionsSettingsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * Providers merged into the Connections section (credits/settings redesign
 * 2026-08-22): old links land on the combined page, model providers up top.
 */
export default function LegacyProvidersSettingsPage() {
  redirect(connectionsSettingsPath());
}
