import { redirect } from "next/navigation";

import { connectionsSettingsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * The integrations section became Observability (gw-shell P9), which then
 * merged into Connections (credits/settings redesign 2026-08-22). Connect
 * flows that stored a /settings/integrations?returnTo=… round-trip URL land
 * here, so the param rides the redirect — one hop, straight to the merged page.
 */
export default async function LegacyIntegrationsSettingsPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  redirect(connectionsSettingsPath(returnTo));
}
