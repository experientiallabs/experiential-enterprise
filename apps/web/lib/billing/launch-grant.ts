import type { createServerSupabaseClient } from "@/lib/auth/server";

// The launch-grant EVENT amount: what a welcome surface may announce. One
// module so the login modal's success step (/api/welcome) and the sidebar
// credit greeting (/api/account/credit-welcome, PR #685) compute it one way —
// $20 on a standard signup, the configured YC amount on a claim — and neither
// ever announces the cumulative `credit_granted_usd` counter, which also
// counts Stripe top-ups (announcing it once greeted a seeded demo org with
// "$776 in credits added": $526 YC + $250 of top-ups).

type LedgerRow = {
  entry_type?: unknown;
  amount_usd?: unknown;
  source_ref?: unknown;
};

/**
 * The org's launch-grant total from its ledger: `grant` rows from
 * `signup_promo`/`yc_launch` plus the YC promo-fold reversal (the
 * `promo-reversal:` adjustment), read RLS-scoped (members may select their
 * org's history). Top-ups (source `stripe`) never enter the filter and
 * expiry/revoke adjustments are excluded. Null when the read fails.
 */
export async function readLaunchGrantUsd(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  orgId: string
): Promise<number | null> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("entry_type, amount_usd, source_ref")
    .eq("org_id", orgId)
    .in("source", ["signup_promo", "yc_launch"]);
  if (error !== null || data === null) {
    return null;
  }
  let total = 0;
  for (const row of data as LedgerRow[]) {
    const amount = row.amount_usd;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      continue;
    }
    if (row.entry_type === "grant") {
      total += amount;
    } else if (
      row.entry_type === "adjustment" &&
      typeof row.source_ref === "string" &&
      row.source_ref.startsWith("promo-reversal:")
    ) {
      total += amount;
    }
  }
  return total;
}
