import { ActivityView } from "@/components/activity/activity-view";
import { InsightsLocked } from "@/components/insights/insights-locked";
import { resolveActiveOrg } from "@/lib/active-org";
import { getAuthenticatedUser } from "@/lib/auth/server";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { getDataSource } from "@/lib/data-source";
import { catalogModelSlugs } from "@/lib/model-links";
import type { ServingWindow } from "@/lib/types";

export const metadata = { title: "Insights" };

export const dynamic = "force-dynamic";

const WINDOWS: readonly ServingWindow[] = ["24h", "7d", "30d"];
const DEFAULT_WINDOW: ServingWindow = "7d";

type InsightsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Insights: the deep usage-analytics dashboard over the gateway. Every graph is
 * shown at once (spend and requests by model, credits vs BYOK, top models, top
 * API keys, providers) with a window selector, plus the natural-language
 * Intelligence query and usage-tied suggestions folded in as a second tab.
 * Everything is sourced from the org's OWN gateway usage aggregates, so nothing
 * renders that is not real. Insights are account-scoped, so the signed-out
 * visitor gets a sign-in card rather than a demo.
 */
export default async function InsightsPage({ searchParams }: InsightsPageProps) {
  const user = await getAuthenticatedUser();
  if (user === null) {
    return (
      <div className="flex min-h-full flex-col gap-4 page-bottom-pad">
        <InsightsLocked />
      </div>
    );
  }
  const params = await searchParams;
  const rawWindow = typeof params.window === "string" ? params.window : null;
  const window: ServingWindow = WINDOWS.includes(rawWindow as ServingWindow)
    ? (rawWindow as ServingWindow)
    : DEFAULT_WINDOW;

  const org = await resolveActiveOrg();
  const source = getDataSource();
  const [timeseries, byKey, byProvider, byPrompt, suggestions, modelSlugs, canManagePromptCapture] =
    await Promise.all([
      source.getUsageTimeseries(org.id, { window }),
      source.getUsageByKey(org.id, window),
      source.getUsageByProvider(org.id, window),
      source.getUsageByPrompt(org.id, window),
      source.getSuggestions(org.id, window),
      catalogModelSlugs(),
      // The prompt-capture opt-in renders on the Intelligence tab too (it is
      // where the benefit shows); flipping it is an org-wide privacy decision,
      // so admin-gated exactly like the Settings card.
      isPlatformAdmin().then(async (admin) => admin || isOrgAdmin(user.id, org.id))
    ]);

  return (
    // The page grows past the viewport, which overflows the shell's h-full
    // content box and swallows <main>'s own bottom padding — so the scrolling
    // page carries its own, mirroring the shell's clamp (AppShell.tsx).
    <div className="flex min-h-full flex-col gap-4 page-bottom-pad">
      <ActivityView
        byKey={byKey}
        byPrompt={byPrompt}
        byProvider={byProvider}
        canManagePromptCapture={canManagePromptCapture}
        knownModelSlugs={modelSlugs}
        nowMs={Date.now()}
        orgId={org.id}
        suggestions={suggestions.suggestions}
        timeseries={timeseries}
        window={window}
      />
    </div>
  );
}
