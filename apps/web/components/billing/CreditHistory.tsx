"use client";

import { useEffect, useState } from "react";

import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import { formatCostUsd } from "@/lib/money";
import type { CreditLedgerEntry } from "@/lib/types";

type CreditHistoryProps = {
  /** Null renders the signed-out frame: no account-scoped fetch fires. */
  orgId: string | null;
};

const ENTRY_TYPE_LABEL: Record<CreditLedgerEntry["entry_type"], string> = {
  grant: "Grant",
  topup: "Top-up",
  adjustment: "Adjustment"
};

/** Grant/top-up/adjustment history from the append-only ledger, table-first. */
export function CreditHistory({ orgId }: CreditHistoryProps) {
  // Signed-out starts (and stays) on the empty table rather than "Loading…"
  // for data that will never arrive.
  const [entries, setEntries] = useState<CreditLedgerEntry[] | null>(
    orgId === null ? [] : null
  );

  useEffect(() => {
    if (orgId === null) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/credit/ledger`, {
          cache: "no-store"
        });
        if (!response.ok || cancelled) {
          return;
        }
        const payload = (await response.json()) as { entries?: CreditLedgerEntry[] };
        if (!cancelled && Array.isArray(payload.entries)) {
          setEntries(payload.entries);
        }
      } catch {
        // Leave the section in its loading state; history is not load-bearing.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <section
      className="border border-line rounded-lg bg-surface p-[18px]"
      data-testid="credit-history"
    >
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold text-ink">Credit history</h2>
        {entries !== null && entries.length > 0 && (
          <span className="text-[12px] text-muted-2">
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}
          </span>
        )}
      </div>
      {entries === null ? (
        <div aria-hidden className="flex flex-col gap-2" data-testid="credit-history-loading">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="flex items-center gap-3" key={index}>
              <Shimmer className="h-3.5 w-28" />
              <Shimmer className="h-3.5 w-16" />
              <Shimmer className="h-3.5 flex-1" />
              <Shimmer className="h-3.5 w-16" />
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="m-0 text-[13px] leading-relaxed text-muted">
          No credit entries yet. Grants and top-ups appear here.
        </p>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line">
              <th className="mono-label pb-2 pr-3 text-left font-normal">Date</th>
              <th className="mono-label pb-2 pr-3 text-left font-normal">Type</th>
              <th className="mono-label pb-2 pr-3 text-left font-normal">Reason</th>
              <th className="mono-label pb-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr className="border-b border-line last:border-b-0" key={entry.id}>
                <td className="whitespace-nowrap py-2 pr-3 text-muted">
                  <LocalDateTime value={entry.created_at} withYear />
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-ink">
                  {ENTRY_TYPE_LABEL[entry.entry_type]}
                </td>
                <td className="max-w-0 overflow-hidden text-ellipsis whitespace-nowrap py-2 pr-3 text-ink">
                  {entry.reason ?? creditSourceLabel(entry.source)}
                </td>
                <td
                  className={
                    entry.amount_usd < 0
                      ? "whitespace-nowrap py-2 text-right font-mono text-red-600/80"
                      : "whitespace-nowrap py-2 text-right font-mono text-ink"
                  }
                >
                  {entry.amount_usd < 0 ? "-" : "+"}
                  {formatCostUsd(Math.abs(entry.amount_usd))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Human label for a ledger source when no reason line was recorded. */
function creditSourceLabel(source: CreditLedgerEntry["source"]): string {
  switch (source) {
    case "signup_promo":
      return "Welcome credit";
    case "migration":
      return "Opening balance";
    case "admin":
      return "Support grant";
    case "stripe":
      return "Credit top-up";
    case "yc_launch":
      return "YC launch grant";
    default:
      return "Credit entry";
  }
}
