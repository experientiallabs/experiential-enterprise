import { notFound } from "next/navigation";

import { CreditsView, EMPTY_USAGE_REPORT } from "@/components/billing/CreditsView";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { getAuthenticatedUser, requireAuthenticatedUser } from "@/lib/auth/server";
import { loadProviderConnections } from "@/lib/billing/provider-balances-server";
import { orgIsYcCompany } from "@/lib/billing/tool-accounts-server";
import { getDataSource } from "@/lib/data-source";
import { DataSourceNotFoundError } from "@/lib/errors";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import type { OrgUsageReport } from "@/lib/types";

export const metadata = { title: "Credits" };

export const dynamic = "force-dynamic";

/**
 * The money page: ONE combined view of platform credits and own-key (BYOK)
 * spend — the spend graph, spend per provider, the provider-balance squares
 * (connect in place), top-ups, and the YC deals — with auto-recharge, spend
 * alerts, and history behind the page's Settings tab. Public per the gating
 * contract: a signed-out visitor gets the full page with empty-state numbers,
 * no account-scoped fetches, and login-gated actions.
 */
export default async function CreditsPage() {
  const user = await getAuthenticatedUser();
  const webBaseUrl = process.env.EXPLABS_WEBAPP_URL ?? PLATFORM_WEB_URL;
  const apiBaseUrl = publicServingBaseUrl();
  const body =
    user === null ? (
      <CreditsView
        apiBaseUrl={apiBaseUrl}
        initialReport={EMPTY_USAGE_REPORT}
        orgId={null}
        webBaseUrl={webBaseUrl}
      />
    ) : (
      await signedInBody(webBaseUrl, apiBaseUrl)
    );
  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div>
        <h1 className="m-0 text-ink text-xl font-semibold">Credits</h1>
        <p className="mt-2 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Your inference spend in one place: platform credits and your own keys, combined.
        </p>
      </div>
      {body}
    </div>
  );
}

async function signedInBody(webBaseUrl: string, apiBaseUrl: string) {
  const org = await resolveActiveOrg();
  const [report, providerConnections, isYcCompany] = await Promise.all([
    loadUsageReport(org.id),
    loadProviderConnections(org.id),
    orgIsYcCompany(org.id)
  ]);
  // Top-ups, spend-alert rules, and provider connects are org-admin actions;
  // the same role gate covers each.
  const isAdmin = org.role === "admin" || org.role === "platform_admin";
  return (
    <CreditsView
      apiBaseUrl={apiBaseUrl}
      canManageAlerts={isAdmin}
      canManageProviders={isAdmin}
      canTopUp={isAdmin}
      initialReport={report}
      isYcCompany={isYcCompany}
      orgId={org.id}
      providerConnections={providerConnections}
      webBaseUrl={webBaseUrl}
    />
  );
}

async function loadUsageReport(orgId: string): Promise<OrgUsageReport> {
  try {
    return await getDataSource().getOrgUsage(orgId);
  } catch (error) {
    if (error instanceof DataSourceNotFoundError) {
      notFound();
    }
    throw error;
  }
}
