"use client";

import { useCallback, useEffect, useState } from "react";

import { Shimmer } from "@/components/ui/Shimmer";
import {
  MAX_TOPUP_USD,
  MIN_TOPUP_USD,
  type AutoRechargeSettings
} from "@/lib/billing/constants";
import { formatCostUsd } from "@/lib/money";

type AutoRechargeCardProps = {
  /** Signed-in org whose settings this manages; the panel is admin-only. */
  orgId: string;
};

/**
 * Manage auto-recharge from the credits page: an honest current-state line
 * ("Auto-recharge is on: we'll add $5 when you drop below $10"), an enable
 * toggle, and editable amount + threshold. A card can only be SAVED through a
 * consented top-up, so until one is on file this panel explains that and stays
 * a preview; once it is, the toggle and fields take effect immediately.
 */
export function AutoRechargeCard({ orgId }: AutoRechargeCardProps) {
  const [settings, setSettings] = useState<AutoRechargeSettings | null>(null);
  const [amount, setAmount] = useState("");
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((next: AutoRechargeSettings) => {
    setSettings(next);
    setAmount(String(next.amountUsd));
    setThreshold(String(next.thresholdUsd));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/auto-recharge`, {
          cache: "no-store"
        });
        if (!response.ok || cancelled) {
          return;
        }
        const payload = (await response.json()) as AutoRechargeSettings;
        if (!cancelled) {
          apply(payload);
        }
      } catch {
        // Transient; the panel simply stays in its loading state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, apply]);

  async function save(patch: Partial<{ enabled: boolean; amount_usd: number; threshold_usd: number }>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/auto-recharge`, {
        body: JSON.stringify(patch),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      const payload = (await response.json().catch(() => null)) as
        | (AutoRechargeSettings & { error?: string })
        | null;
      if (!response.ok || payload === null) {
        setError(payload?.error ?? "Unable to save auto-recharge.");
        return;
      }
      apply(payload);
      setNotice("Saved.");
    } catch {
      setError("Unable to save auto-recharge. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  if (settings === null) {
    // Shaped like the loaded card (heading + toggle, state line, the two
    // fields and Save) so switching to this tab never shifts the layout.
    return (
      <section
        aria-hidden
        className="border border-line rounded-lg bg-surface p-[18px]"
        data-testid="auto-recharge-loading"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <Shimmer className="h-3.5 w-28" />
          <Shimmer className="h-4 w-16" />
        </div>
        <Shimmer className="mb-3 h-3.5 w-[420px] max-w-full" />
        <div className="flex flex-wrap items-end gap-3">
          <Shimmer className="h-[52px] w-[110px] rounded-[var(--radius-md)]" />
          <Shimmer className="h-[52px] w-[110px] rounded-[var(--radius-md)]" />
          <Shimmer className="h-[34px] w-20 rounded-[var(--radius-md)]" />
        </div>
      </section>
    );
  }

  const amountNumber = Number(amount);
  const thresholdNumber = Number(threshold);
  const fieldsValid =
    Number.isFinite(amountNumber) &&
    amountNumber >= MIN_TOPUP_USD &&
    amountNumber <= MAX_TOPUP_USD &&
    Number.isFinite(thresholdNumber) &&
    thresholdNumber >= 0;
  const failing = settings.consecutiveFailures > 0;

  return (
    <section
      className="border border-line rounded-lg bg-surface p-[18px]"
      data-testid="auto-recharge"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold text-ink">Auto-recharge</h2>
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input
            checked={settings.enabled}
            className="h-4 w-4 accent-foreground"
            disabled={busy}
            onChange={(event) => void save({ enabled: event.target.checked })}
            type="checkbox"
          />
          {settings.enabled ? "On" : "Off"}
        </label>
      </div>

      <p className="m-0 mb-3 text-[13px] text-muted" data-testid="auto-recharge-state">
        {stateLine(settings)}
      </p>

      {failing && (
        <p
          className="m-0 mb-3 rounded-[var(--radius-md)] border border-warning/25 bg-warning-soft px-3 py-2 text-[13px] text-warning"
          data-testid="auto-recharge-failed"
          role="status"
        >
          The last recharge did not go through{settings.lastFailureMessage ? `: ${settings.lastFailureMessage}` : "."} Add
          credits with a working card to resume.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-2">
          Add
          <input
            aria-label="Auto-recharge amount in USD"
            className="min-h-[34px] w-[110px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] font-normal normal-case tracking-normal text-ink focus:outline-none focus:border-line-strong"
            max={MAX_TOPUP_USD}
            min={MIN_TOPUP_USD}
            onChange={(event) => setAmount(event.target.value)}
            step="0.01"
            type="number"
            value={amount}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-2">
          When below
          <input
            aria-label="Auto-recharge threshold in USD"
            className="min-h-[34px] w-[110px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] font-normal normal-case tracking-normal text-ink focus:outline-none focus:border-line-strong"
            min={0}
            onChange={(event) => setThreshold(event.target.value)}
            step="0.01"
            type="number"
            value={threshold}
          />
        </label>
        <button
          className="cursor-pointer rounded-[var(--radius-md)] border border-line bg-surface px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:cursor-default disabled:opacity-50"
          disabled={busy || !fieldsValid}
          onClick={() =>
            void save({ amount_usd: amountNumber, threshold_usd: thresholdNumber })
          }
          type="button"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>

      {!settings.hasPaymentMethod && (
        <p className="m-0 mt-3 text-[11px] text-muted-2">
          No card on file yet. Add credits above with &ldquo;Keep my card&rdquo; checked to arm
          auto-recharge; these settings apply once it is saved.
        </p>
      )}
      {error && <p className="m-0 mt-2 text-[13px] text-danger">{error}</p>}
      {notice && !error && <p className="m-0 mt-2 text-[13px] text-muted">{notice}</p>}
    </section>
  );
}

function stateLine(settings: AutoRechargeSettings): string {
  const add = formatCostUsd(settings.amountUsd);
  const below = formatCostUsd(settings.thresholdUsd);
  if (!settings.hasPaymentMethod) {
    return `Set up: we'll add ${add} whenever your balance drops below ${below}, once a card is on file.`;
  }
  if (!settings.enabled) {
    return `Auto-recharge is off. Turn it on to add ${add} whenever your balance drops below ${below}.`;
  }
  return `Auto-recharge is on: we'll add ${add} whenever your balance drops below ${below}.`;
}
