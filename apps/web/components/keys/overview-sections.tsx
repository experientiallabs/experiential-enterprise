"use client";

// EXPORTED SHELL — the Overview page's credit-accounts KeyHub mount. keys-P8
// fills the internals (one row per connected provider account: current
// credits or the honest not-reported state, month spend, the over-time chart
// from provider_account_snapshots, a per-row refresh against keys-P2's
// spend-refresh endpoint, and editable self-reported balances). Exported now,
// one-line mountable with zero page assumptions, so the telemetry workstream
// can place it before keys-P8 lands. The Overview's "your API key" moment is
// <OrgApiKeysSection>, mounted alongside.

import { useLoginModal } from "@/components/auth/login-modal-context";
import { Button } from "@/components/ui/Button";

export type CreditAccountsSectionProps = {
  /** Null renders the signed-out state (structure visible, actions prompt login). */
  orgId: string | null;
};

export function CreditAccountsSection({ orgId }: CreditAccountsSectionProps) {
  const { open } = useLoginModal();
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-[18px]"
      data-testid="credit-accounts-section"
    >
      <p className="mono-label m-0">Credit accounts</p>
      <p className="m-0 max-w-[780px] text-[13px] leading-relaxed text-muted">
        Credits, spend, and usage limits across your connected provider accounts — and how they
        change over time.
      </p>
      {/* Placeholder body until keys-P8 — the per-account rows, the snapshot
          chart, and the refresh affordance are that packet's spec. */}
      {orgId === null ? (
        <div>
          <Button onClick={open} size="sm" type="button">
            Sign in to see your credits
          </Button>
        </div>
      ) : (
        <p className="m-0 text-[12px] text-muted-2">
          Account balances appear here as snapshots accumulate.
        </p>
      )}
    </section>
  );
}
