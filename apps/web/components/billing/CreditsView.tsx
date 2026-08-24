"use client";

import { useEffect, useState } from "react";

import { AddCreditsCard } from "@/components/billing/AddCreditsCard";
import { AutoRechargeCard } from "@/components/billing/AutoRechargeCard";
import { CreditHistory } from "@/components/billing/CreditHistory";
import { DealsSection } from "@/components/billing/DealsSection";
import { ProviderBalanceGrid } from "@/components/billing/ProviderBalanceGrid";
import { SpendAlertsCard } from "@/components/billing/SpendAlertsCard";
import { SpendOverviewCard } from "@/components/billing/SpendOverviewCard";
import type { ProviderConnectionState } from "@/components/settings/ModelProvidersPanel";
import { SlidingTabs, type SlidingTab } from "@/components/ui/SlidingTabs";
import { MIN_TOPUP_USD } from "@/lib/billing/constants";
import { DISCONNECTED_PROVIDER_CONNECTIONS } from "@/lib/billing/provider-balances";
import type { OrgUsageReport } from "@/lib/types";

// /api/orgs/{id}/usage is a counters-only read (one organizations row) since
// the legacy per-model and per-endpoint folds were deleted, but the 10s
// cadence stays: meter writes still appear without a navigation, and a page
// nobody watches tick by tick has no business polling faster.
export const USAGE_POLL_INTERVAL_MS = 10000;

/** The signed-out numbers (Contract 5): the page renders, nothing fetches. */
export const EMPTY_USAGE_REPORT: OrgUsageReport = {
  credit: {
    spend_usd: 0,
    billable_spend_usd: 0,
    credit_granted_usd: 0,
    credit_balance_usd: 0,
    yc: null
  }
};

type CreditsTab = "overview" | "settings";

type CreditsViewProps = {
  /** Null renders the public page: empty-state numbers, actions gated. */
  orgId: string | null;
  initialReport: OrgUsageReport;
  /** Org admins (and operators) may start a Stripe top-up from this page. */
  canTopUp?: boolean;
  /** Org admins (and operators) may add or remove spend-alert rules. */
  canManageAlerts?: boolean;
  /** Org admins (and operators) may connect providers from the balance grid. */
  canManageProviders?: boolean;
  /**
   * The org's inference-provider accounts, for the balance grid and deals.
   * Omitted signed-out; the page then shows every provider as an unconnected
   * tile without an account-scoped read.
   */
  providerConnections?: readonly ProviderConnectionState[];
  /** YC orgs get the per-tile Bookface deal links in the balance grid. */
  isYcCompany?: boolean;
  /** Public web origin, threaded to the connect modal's transfer prompt. */
  webBaseUrl: string;
  /** Public API base URL, threaded to the connect modal's transfer prompt. */
  apiBaseUrl: string;
};

/**
 * The whole /credits page body: ONE combined money view (the product owner, credits
 * redesign 2026-08-22 — the old Balances/Spend split and its meter
 * fragmentation collapsed). Two top-line tabs: the default view carries the
 * combined spend graph, spend per provider, the compact provider-balance
 * squares (connect in place), add-credits, and the YC deals; the Settings tab
 * carries auto-recharge, spend alerts, and the ledger history. Refreshes the
 * counters while open so meter writes appear without a navigation.
 */
export function CreditsView({
  orgId,
  initialReport,
  canTopUp = false,
  canManageAlerts = false,
  canManageProviders = false,
  providerConnections,
  isYcCompany = false,
  webBaseUrl,
  apiBaseUrl
}: CreditsViewProps) {
  const [report, setReport] = useState(initialReport);
  const [tab, setTab] = useState<CreditsTab>("overview");
  // Signed-out (or member-without-top-up) never mints a Stripe session; the
  // add-credits card only appears when the action is available.
  const showAddCredits = orgId === null || canTopUp;
  const connections = providerConnections ?? DISCONNECTED_PROVIDER_CONNECTIONS;

  useEffect(() => {
    setReport(initialReport);
  }, [initialReport]);

  useEffect(() => {
    if (orgId === null) {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/usage`, {
          cache: "no-store"
        });
        if (!response.ok || cancelled) {
          return;
        }
        const next = (await response.json()) as OrgUsageReport;
        if (!cancelled) {
          setReport(next);
        }
      } catch {
        // Transient refresh failure; the next tick retries.
      }
    };
    const timer = setInterval(() => void refresh(), USAGE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orgId]);

  // Below one minimum top-up of runway. Signed-out zeros never qualify: the
  // empty-state numbers are placeholders, not a balance. The banner still
  // shows for an auto-recharge org (the charge settles out of band and the
  // counters refresh when its credit lands), so the customer always sees the
  // low state and the manual top-up remains one click away.
  const lowBalance = orgId !== null && report.credit.credit_balance_usd < MIN_TOPUP_USD;

  const tabs: SlidingTab[] = [
    { key: "overview", label: "Overview" },
    { key: "settings", label: "Settings" }
  ];

  return (
    // pb keeps the last section off the viewport bottom: this is the flowing
    // content that overflows the shell's scroll area, and a scroll container
    // drops its own padding-bottom, so the trailing space has to live here.
    // No new scrollbar: the shell already scrolls when this is tall.
    <div className="flex flex-col gap-5 pb-6">
      {lowBalance && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-warning/25 bg-warning-soft px-3.5 py-2.5"
          data-testid="low-balance-banner"
          role="status"
        >
          <span className="text-[13px] text-warning">
            You&rsquo;re almost out of credits. Platform-funded requests stop at $0; your own
            provider keys keep working.
          </span>
          {showAddCredits ? (
            <button
              className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[13px] font-medium text-warning underline underline-offset-2"
              onClick={() => {
                // The add-credits card lives on the default tab; land there
                // and bring it into view once that tab has rendered.
                setTab("overview");
                requestAnimationFrame(() => {
                  document.getElementById("add-credits")?.scrollIntoView({ block: "center" });
                });
              }}
              type="button"
            >
              Add credits
            </button>
          ) : (
            <span className="shrink-0 text-[13px] text-warning">
              Ask an org admin to top up.
            </span>
          )}
        </div>
      )}
      <SlidingTabs
        activeKey={tab}
        ariaLabel="Credits sections"
        onPick={(key) => setTab(key as CreditsTab)}
        tabs={tabs}
      />
      {tab === "overview" && (
        <div className="flex flex-col gap-5">
          <SpendOverviewCard orgId={orgId} report={report} />
          {/* Add credits sits ABOVE the provider squares (the product owner, 2026-08-23):
              topping up the platform balance is the primary action here. */}
          {showAddCredits && <AddCreditsCard orgId={orgId} />}
          <ProviderBalanceGrid
            apiBaseUrl={apiBaseUrl}
            canManage={canManageProviders}
            connections={connections}
            isYcCompany={isYcCompany}
            orgId={orgId}
            webBaseUrl={webBaseUrl}
          />
          <DealsSection connections={connections} />
        </div>
      )}
      {tab === "settings" && (
        <div className="flex flex-col gap-5">
          {/* Auto-recharge and spend alerts are account-scoped (admin-gated
              rules over the org's budgets), so the signed-out Settings tab
              shows only the empty history frame. */}
          {orgId !== null && <AutoRechargeCard orgId={orgId} />}
          {orgId !== null && <SpendAlertsCard canManage={canManageAlerts} orgId={orgId} />}
          <CreditHistory orgId={orgId} />
        </div>
      )}
    </div>
  );
}
