"use client";

import { useEffect, useState } from "react";

import { formatCostUsd, formatSignedCostUsd } from "@/lib/money";

// Shared client-side loader for the admin Organizations surfaces: both the
// cards browse and a single org's detail read the same per-org credit and spend
// figures from the one bulk admin endpoint (the backend computes every tenant
// in a constant number of scans). Keeping the type, the poll, and the gauge
// string in one module stops the two surfaces drifting apart.

const USAGE_POLL_INTERVAL_MS = 3000;

export type OrgCredit = {
  spend_usd: number;
  billable_spend_usd: number;
  credit_granted_usd: number;
  credit_balance_usd: number;
  // When set, an admin lifted the org's free-credit daily caps ($50/day org,
  // $25/day per model); the caps otherwise bind until the first paid top-up.
  free_credit_caps_lifted_at: string | null;
  // Platform-funded gateway attempts billed $0 for an unknown cost — a
  // review signal ("no markup" forbids billing a guess).
  gateway_unknown_cost_attempts: number;
};

/** "…" while loading, "unavailable" on a failed bulk read, else the gauge. */
export function creditCell(credit: OrgCredit | null | undefined): string {
  if (credit === undefined) {
    return "…";
  }
  if (credit === null) {
    return "unavailable";
  }
  return (
    `${formatSignedCostUsd(credit.credit_balance_usd)} left of ` +
    `${formatCostUsd(credit.credit_granted_usd)} · ${formatCostUsd(credit.spend_usd)} metered`
  );
}

/**
 * Poll every org's live credit and spend after render. Returns a map keyed by
 * org id: `undefined` (absent key) means still loading, `null` marks a failed
 * load, and a value is the latest figures. The bulk read is one request no
 * matter how many org ids are passed.
 */
export function useOrgUsage(orgIds: string[]): Record<string, OrgCredit | null> {
  const [creditByOrg, setCreditByOrg] = useState<Record<string, OrgCredit | null>>({});
  // Re-run only when the set of ids changes, not on every array identity churn.
  const idsKey = orgIds.join(",");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      let credit: Record<string, OrgCredit | null> = Object.fromEntries(
        idsKey === "" ? [] : idsKey.split(",").map((id) => [id, null])
      );
      try {
        const response = await fetch("/api/admin/orgs/usage", { cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as {
            orgs: Array<{ org_id: string } & OrgCredit>;
          };
          credit = {
            ...credit,
            ...Object.fromEntries(
              body.orgs.map((org) => [
                org.org_id,
                {
                  spend_usd: org.spend_usd,
                  billable_spend_usd: org.billable_spend_usd,
                  credit_granted_usd: org.credit_granted_usd,
                  credit_balance_usd: org.credit_balance_usd,
                  free_credit_caps_lifted_at: org.free_credit_caps_lifted_at,
                  gateway_unknown_cost_attempts: org.gateway_unknown_cost_attempts
                }
              ])
            )
          };
        }
      } catch {
        // Unreachable backend degrades every credit cell to "unavailable".
      }
      if (!cancelled) {
        setCreditByOrg(credit);
      }
    }
    void load();
    const timer = setInterval(() => void load(), USAGE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [idsKey]);

  return creditByOrg;
}
