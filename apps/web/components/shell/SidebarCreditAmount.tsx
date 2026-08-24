"use client";

import { useEffect, useState } from "react";

import { CreditsWelcome } from "@/components/shell/CreditsWelcome";
import { formatSignedCostUsd } from "@/lib/money";
import type { OrgBudget } from "@/lib/types";

const POLL_MS = 3000;

type SidebarCreditAmountProps = {
  orgSlug: string;
  billableUsd?: number;
  grantedUsd?: number;
};

/**
 * The org's remaining credit as one compact figure, rendered inline to the left
 * of the sidebar "Credits" nav item (the product owner, ux-polish): the standalone meter it
 * replaced showed the same balance as its own block, so the number now rides the
 * tab it links to. It reuses the meter's balance source — the same lightweight
 * /budget poll seeded from the server-rendered org packet — so no extra fetch is
 * introduced, and it still anchors the signup-credit welcome bubble. Renders
 * nothing until a valid balance is known, leaving just the plain "Credits" tab.
 */
export function SidebarCreditAmount({
  orgSlug,
  billableUsd: initialBillableUsd,
  grantedUsd: initialGrantedUsd
}: SidebarCreditAmountProps) {
  const [credit, setCredit] = useState<{
    billableUsd: number | undefined;
    grantedUsd: number | undefined;
  }>({ billableUsd: initialBillableUsd, grantedUsd: initialGrantedUsd });

  useEffect(() => {
    setCredit({ billableUsd: initialBillableUsd, grantedUsd: initialGrantedUsd });
  }, [initialBillableUsd, initialGrantedUsd]);

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;

    async function refresh(): Promise<void> {
      const request = ++latestRequest;
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/budget`, {
          cache: "no-store"
        });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { budget?: Partial<OrgBudget> };
        const nextBillable = payload.budget?.billable_spend_usd;
        const nextGranted = payload.budget?.credit_granted_usd;
        if (!isNonNegativeNumber(nextBillable) || !isNonNegativeNumber(nextGranted)) {
          return;
        }
        if (!cancelled && request === latestRequest) {
          setCredit({ billableUsd: nextBillable, grantedUsd: nextGranted });
        }
      } catch {
        // Keep the last known figure through transient network failures.
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orgSlug]);

  const { billableUsd, grantedUsd } = credit;
  const validBillable = isNonNegativeNumber(billableUsd) ? billableUsd : undefined;
  const validGranted = isNonNegativeNumber(grantedUsd) ? grantedUsd : undefined;
  if (validBillable === undefined || validGranted === undefined) {
    return null;
  }
  // Remaining can go negative after an overdraw; show it honestly.
  const remaining = validGranted - validBillable;

  return (
    <CreditsWelcome className="relative inline-flex items-center" granted={validGranted}>
      <span className="font-mono text-[11px] leading-none text-foreground/45">
        {formatSignedCostUsd(remaining)}
      </span>
    </CreditsWelcome>
  );
}

/** Treat missing or malformed deployment-skew values as unavailable, never as zero. */
function isNonNegativeNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
