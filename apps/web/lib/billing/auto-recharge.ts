// Server-only: turn queued auto-recharge attempts into Stripe off-session
// charges. The database decides WHO gets recharged (the balance trigger +
// enqueue_auto_recharge_if_low); this drains that queue, creates one
// off-session PaymentIntent per attempt, and leaves the crediting to the
// Stripe webhook (payment_intent.succeeded), so credits still only ever appear
// as a webhook-driven ledger row. A synchronous decline is recorded here so a
// dead card never loops; a transient error resets the attempt for the next
// pass. Both Stripe and the Supabase admin client are injected so the trigger
// logic is unit-testable without either service.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { AUTORECHARGE_PURPOSE } from "@/lib/billing/constants";

// How long a claimed ("processing") attempt with no PaymentIntent id yet may
// sit before another pass re-leases it. Covers the crash window between
// claiming an attempt and recording its PaymentIntent; the create call carries
// the attempt id as its idempotency key, so a re-lease never double-charges.
const LEASE_MS = 5 * 60 * 1000;

// Default fan-out per invocation. A cron tick that finds more than this leaves
// the rest for the next tick rather than holding one request open for minutes.
const DEFAULT_BATCH_LIMIT = 25;

type AttemptRow = {
  id: string;
  org_id: string;
  amount_usd: number;
  status: string;
  stripe_payment_intent_id: string | null;
  updated_at: string;
};

type SettingsRow = {
  org_id: string;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
};

export type AutoRechargeRunSummary = {
  claimed: number;
  charged: number;
  declined: number;
  retryable: number;
  skipped: number;
};

export type ProcessAutoRechargeDeps = {
  stripe: Stripe;
  admin: SupabaseClient;
  limit?: number;
  /** Injectable clock for deterministic lease math in tests. */
  now?: () => Date;
};

/**
 * Drain the auto-recharge queue: claim each pending (or stale-processing)
 * attempt and create its off-session PaymentIntent. Returns a per-run tally.
 */
export async function processPendingAutoRecharges(
  deps: ProcessAutoRechargeDeps
): Promise<AutoRechargeRunSummary> {
  const { stripe, admin } = deps;
  const now = deps.now ?? (() => new Date());
  const limit = deps.limit ?? DEFAULT_BATCH_LIMIT;
  const summary: AutoRechargeRunSummary = {
    claimed: 0,
    charged: 0,
    declined: 0,
    retryable: 0,
    skipped: 0
  };

  const cutoff = new Date(now().getTime() - LEASE_MS).toISOString();
  const candidates = await admin
    .from("auto_recharge_attempts")
    .select("id, org_id, amount_usd, status, stripe_payment_intent_id, updated_at")
    .or(
      `status.eq.pending,and(status.eq.processing,stripe_payment_intent_id.is.null,updated_at.lt.${cutoff})`
    )
    .order("created_at", { ascending: true })
    .limit(limit);
  if (candidates.error) {
    throw new Error(`auto-recharge: loading attempts failed: ${candidates.error.message}`);
  }
  const rows = (candidates.data ?? []) as AttemptRow[];
  if (rows.length === 0) {
    return summary;
  }

  const settingsByOrg = await loadSettings(
    admin,
    rows.map((row) => row.org_id)
  );

  for (const attempt of rows) {
    const claimed = await claimAttempt(admin, attempt, now);
    if (!claimed) {
      summary.skipped += 1; // another worker took it, or the CAS lost
      continue;
    }
    summary.claimed += 1;
    const settings = settingsByOrg.get(attempt.org_id);
    if (!settings?.stripe_customer_id || !settings?.stripe_payment_method_id) {
      // enqueue guards against this, but a card removed between enqueue and now
      // leaves nothing to charge; close the attempt so it stops blocking.
      await failAttemptById(admin, attempt.id, "No saved payment method.", now);
      summary.skipped += 1;
      continue;
    }
    const outcome = await chargeAttempt({ stripe, admin, attempt, settings, now });
    summary[outcome] += 1;
  }
  return summary;
}

async function loadSettings(
  admin: SupabaseClient,
  orgIds: string[]
): Promise<Map<string, SettingsRow>> {
  const unique = Array.from(new Set(orgIds));
  const result = await admin
    .from("org_auto_recharge_settings")
    .select("org_id, stripe_customer_id, stripe_payment_method_id")
    .in("org_id", unique);
  const map = new Map<string, SettingsRow>();
  for (const row of (result.data ?? []) as SettingsRow[]) {
    map.set(row.org_id, row);
  }
  return map;
}

/**
 * Compare-and-swap the attempt to "processing", keyed on its exact updated_at
 * so only one worker wins the row. Returns true when this caller claimed it.
 */
async function claimAttempt(
  admin: SupabaseClient,
  attempt: AttemptRow,
  now: () => Date
): Promise<boolean> {
  const claim = await admin
    .from("auto_recharge_attempts")
    .update({ status: "processing", updated_at: now().toISOString() })
    .eq("id", attempt.id)
    .eq("updated_at", attempt.updated_at)
    .in("status", ["pending", "processing"])
    .select("id");
  if (claim.error) {
    throw new Error(`auto-recharge: claiming attempt ${attempt.id} failed: ${claim.error.message}`);
  }
  return (claim.data ?? []).length === 1;
}

type ChargeArgs = {
  stripe: Stripe;
  admin: SupabaseClient;
  attempt: AttemptRow;
  settings: SettingsRow;
  now: () => Date;
};

async function chargeAttempt(args: ChargeArgs): Promise<"charged" | "declined" | "retryable"> {
  const { stripe, admin, attempt, settings, now } = args;
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: Math.round(attempt.amount_usd * 100),
        currency: "usd",
        customer: settings.stripe_customer_id ?? undefined,
        payment_method: settings.stripe_payment_method_id ?? undefined,
        off_session: true,
        confirm: true,
        metadata: {
          purpose: AUTORECHARGE_PURPOSE,
          org_id: attempt.org_id,
          attempt_id: attempt.id,
          requested_by: "auto-recharge"
        }
      },
      // The attempt id keys idempotency so a re-leased attempt reuses the same
      // PaymentIntent instead of charging twice.
      { idempotencyKey: attempt.id }
    );
    await admin
      .from("auto_recharge_attempts")
      .update({ stripe_payment_intent_id: intent.id, updated_at: now().toISOString() })
      .eq("id", attempt.id);

    // Off-session should settle straight to succeeded; the webhook credits.
    // Anything that needs interactive auth cannot be completed off-session, so
    // it is a failure the customer resolves with a manual top-up.
    if (intent.status === "requires_action" || intent.status === "requires_payment_method") {
      await recordFailure(admin, attempt.org_id, intent.id, "The card needs authentication.");
      return "declined";
    }
    return "charged";
  } catch (error) {
    const cardError = asStripeCardError(error);
    if (cardError) {
      const intentId = cardError.payment_intent?.id ?? null;
      if (intentId) {
        await admin
          .from("auto_recharge_attempts")
          .update({ stripe_payment_intent_id: intentId, updated_at: now().toISOString() })
          .eq("id", attempt.id);
        await recordFailure(admin, attempt.org_id, intentId, cardError.message);
      } else {
        await failAttemptById(admin, attempt.id, cardError.message, now);
      }
      return "declined";
    }
    // Transient (network, rate limit, config): no charge is guaranteed, so put
    // the attempt back to pending for the next pass; the idempotency key makes
    // a retry safe even if the create did reach Stripe.
    const message = error instanceof Error ? error.message : "unknown error";
    await admin
      .from("auto_recharge_attempts")
      .update({ status: "pending", error_message: message, updated_at: now().toISOString() })
      .eq("id", attempt.id);
    return "retryable";
  }
}

async function recordFailure(
  admin: SupabaseClient,
  orgId: string,
  paymentIntentId: string,
  message: string
): Promise<void> {
  const result = await admin.rpc("record_auto_recharge_failure", {
    in_org: orgId,
    in_payment_intent_id: paymentIntentId,
    in_message: message
  });
  if (result.error) {
    throw new Error(`auto-recharge: recording failure failed: ${result.error.message}`);
  }
}

/**
 * Close an attempt that never reached Stripe (no PaymentIntent), without
 * bumping the anti-loop counter: nothing was charged and nothing declined.
 */
async function failAttemptById(
  admin: SupabaseClient,
  attemptId: string,
  message: string,
  now: () => Date
): Promise<void> {
  await admin
    .from("auto_recharge_attempts")
    .update({ status: "failed", error_message: message, updated_at: now().toISOString() })
    .eq("id", attemptId);
}

type StripeCardErrorShape = { type: string; message: string; payment_intent?: { id?: string } };

/** Duck-typed StripeCardError check (survives SDK class identity across builds). */
function asStripeCardError(error: unknown): StripeCardErrorShape | null {
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "StripeCardError"
  ) {
    return error as StripeCardErrorShape;
  }
  return null;
}
