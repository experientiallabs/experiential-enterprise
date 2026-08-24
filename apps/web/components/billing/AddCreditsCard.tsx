"use client";

import { useEffect, useState } from "react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import {
  DEFAULT_AUTORECHARGE_AMOUNT_USD,
  DEFAULT_AUTORECHARGE_THRESHOLD_USD,
  MAX_TOPUP_USD,
  MIN_TOPUP_USD,
  TOPUP_PRESETS_USD
} from "@/lib/billing/constants";

type AddCreditsCardProps = {
  /** Null renders the signed-out form: everything visible, submit opens login. */
  orgId: string | null;
};

/**
 * Start a Stripe Checkout top-up. Credits arrive when Stripe's webhook
 * reports the session completed — the redirect back to /credits with
 * `?topup=success` confirms payment, and the balance above refreshes on its
 * own poll as the ledger row lands.
 */
export function AddCreditsCard({ orgId }: AddCreditsCardProps) {
  const loginModal = useLoginModal();
  const [amount, setAmount] = useState<string>(String(TOPUP_PRESETS_USD[0]));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Consent is checked by default (the product owner's decision): a first top-up saves the
  // card and arms auto-recharge at a small $5, unless the payer opts out here.
  const [autoRecharge, setAutoRecharge] = useState(true);
  const [autoRechargeAmount, setAutoRechargeAmount] = useState<string>(
    String(DEFAULT_AUTORECHARGE_AMOUNT_USD)
  );

  useEffect(() => {
    // The checkout redirect lands back here with a result flag; read it once
    // (plain location read keeps this component out of Suspense contracts).
    const flag = new URLSearchParams(window.location.search).get("topup");
    if (flag === "success") {
      // The query flag proves the redirect, not the payment; the balance
      // above is what confirms, so the copy stays conditional.
      setNotice("Checkout finished. Once Stripe confirms the payment, the credits appear above.");
    } else if (flag === "cancelled") {
      setNotice("Checkout cancelled; nothing was charged.");
    }
  }, []);

  async function startCheckout(targetOrgId: string) {
    const requested = Number(amount);
    if (!Number.isFinite(requested) || requested < MIN_TOPUP_USD || requested > MAX_TOPUP_USD) {
      setError(
        `Enter between $${MIN_TOPUP_USD} and $${MAX_TOPUP_USD.toLocaleString("en-US")}.`
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(targetOrgId)}/billing/checkout`,
        {
          body: JSON.stringify({
            amount_usd: requested,
            auto_recharge: autoRecharge
              ? {
                  enabled: true,
                  amount_usd: Number(autoRechargeAmount),
                  threshold_usd: DEFAULT_AUTORECHARGE_THRESHOLD_USD
                }
              : { enabled: false }
          }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }
      );
      const payload = (await response.json().catch(() => null)) as {
        url?: string;
        error?: string;
      } | null;
      if (!response.ok || !payload?.url) {
        setError(payload?.error ?? "Unable to start the checkout.");
        setBusy(false);
        return;
      }
      // Deliberately stays busy: location.assign does not block, and a
      // re-enabled button during the navigation window mints a second
      // Checkout session (and a second charge if both get paid).
      window.location.assign(payload.url);
    } catch {
      setError("Unable to start the checkout. Check your connection and retry.");
      setBusy(false);
    }
  }

  return (
    <section
      className="border border-line rounded-lg bg-surface p-[18px]"
      data-testid="add-credits"
      id="add-credits"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold text-ink">Add credits</h2>
        <span className="text-[12px] text-muted-2">$1 = 1 credit · card via Stripe</span>
      </div>
      {notice && <p className="m-0 mb-2 text-[13px] text-muted">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {TOPUP_PRESETS_USD.map((preset) => (
          <button
            className={
              Number(amount) === preset
                ? "cursor-pointer rounded-[var(--radius-md)] border border-foreground/40 bg-foreground/[0.06] px-3 py-1.5 text-[13px] font-medium text-ink"
                : "cursor-pointer rounded-[var(--radius-md)] border border-line bg-surface px-3 py-1.5 text-[13px] text-muted transition-colors hover:text-foreground"
            }
            key={preset}
            onClick={() => setAmount(String(preset))}
            type="button"
          >
            ${preset}
          </button>
        ))}
        <input
          aria-label="Custom top-up amount in USD"
          className="min-h-[34px] w-[120px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]"
          max={MAX_TOPUP_USD}
          min={MIN_TOPUP_USD}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="Custom ($)"
          step="0.01"
          type="number"
          value={amount}
        />
        <button
          className="cursor-pointer rounded-[var(--radius-md)] border border-foreground/70 bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            // Signed-out visitors see the whole form; only acting gates
            // (docs/design-system.md "Gating patterns").
            if (orgId === null) {
              loginModal.open();
              return;
            }
            void startCheckout(orgId);
          }}
          type="button"
        >
          {busy ? "Starting…" : "Continue to payment"}
        </button>
      </div>
      <label
        className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted"
        data-testid="auto-recharge-consent"
      >
        <input
          checked={autoRecharge}
          className="h-4 w-4 accent-foreground"
          onChange={(event) => setAutoRecharge(event.target.checked)}
          type="checkbox"
        />
        <span>Keep my card and auto-recharge</span>
        <input
          aria-label="Auto-recharge amount in USD"
          className="min-h-[30px] w-[84px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-line-strong disabled:opacity-50"
          disabled={!autoRecharge}
          max={MAX_TOPUP_USD}
          min={MIN_TOPUP_USD}
          onChange={(event) => setAutoRechargeAmount(event.target.value)}
          step="0.01"
          type="number"
          value={autoRechargeAmount}
        />
        <span>when my balance runs low.</span>
      </label>
      <p className="m-0 mt-1 text-[11px] text-muted-2">
        You can change the amount, the trigger, or turn this off any time below.
      </p>
      {error && <p className="m-0 mt-2 text-[13px] text-danger">{error}</p>}
      <p className="m-0 mt-2 text-[11px] text-muted-2">
        ${MIN_TOPUP_USD} minimum, ${MAX_TOPUP_USD.toLocaleString("en-US")} per checkout. Credits
        are prepaid, non-refundable through this page, and drawn down by
        metered usage; traffic on your own provider keys never consumes them.
      </p>
    </section>
  );
}
