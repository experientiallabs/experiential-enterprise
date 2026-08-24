import { redirect } from "next/navigation";

import { connectionsSettingsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * Observability merged into the Connections section (credits/settings redesign
 * 2026-08-22). Connect flows that stored a ?returnTo round-trip URL land here,
 * so the param rides the redirect.
 */
export default async function LegacyObservabilitySettingsPage({
  searchParams
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  redirect(connectionsSettingsPath(returnTo));
}
