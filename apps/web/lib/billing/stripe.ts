import Stripe from "stripe";

export { MAX_TOPUP_USD, MIN_TOPUP_USD, TOPUP_PURPOSE, AUTORECHARGE_PURPOSE } from "./constants";
import {
  MAX_AUTORECHARGE_THRESHOLD_USD,
  MAX_TOPUP_USD,
  MIN_AUTORECHARGE_THRESHOLD_USD,
  MIN_TOPUP_USD
} from "./constants";

/**
 * Server-side Stripe client, constructed lazily so builds and tests that
 * never touch billing do not require the secret. Billing is a web-app
 * concern by design: the backend stays payment-agnostic and Stripe's only
 * effect on the platform is an appended `credit_ledger` row.
 */
export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new StripeNotConfiguredError();
  }
  return new Stripe(key);
}

/** Raised when billing routes are hit on a deployment without Stripe keys. */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Billing is not configured on this deployment.");
    this.name = "StripeNotConfiguredError";
  }
}

/** The webhook signing secret; separate accessor because only the webhook needs it. */
export function stripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new StripeNotConfiguredError();
  }
  return secret;
}

/** Parse and validate a requested top-up amount in USD. */
export function parseTopupAmountUsd(value: unknown): number | { error: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: "amount_usd must be a number." };
  }
  // Whole cents only: Stripe charges integers of the smallest unit, and a
  // sub-cent request would silently round somewhere. Refuse instead.
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6) {
    return { error: "amount_usd must be a whole number of cents." };
  }
  if (value < MIN_TOPUP_USD || value > MAX_TOPUP_USD) {
    return {
      error: `amount_usd must be between $${MIN_TOPUP_USD} and $${MAX_TOPUP_USD.toLocaleString("en-US")}.`
    };
  }
  return cents / 100;
}

/**
 * Parse an auto-recharge threshold in USD. Unlike the recharge amount (which
 * reuses the top-up floor/ceiling through parseTopupAmountUsd), the threshold
 * may be as low as $0 — an org that wants a recharge only once it actually hits
 * empty is a legitimate choice — but still whole cents and bounded.
 */
export function parseAutoRechargeThresholdUsd(value: unknown): number | { error: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { error: "threshold_usd must be a number." };
  }
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6) {
    return { error: "threshold_usd must be a whole number of cents." };
  }
  if (value < MIN_AUTORECHARGE_THRESHOLD_USD || value > MAX_AUTORECHARGE_THRESHOLD_USD) {
    return {
      error: `threshold_usd must be between $${MIN_AUTORECHARGE_THRESHOLD_USD} and $${MAX_AUTORECHARGE_THRESHOLD_USD.toLocaleString("en-US")}.`
    };
  }
  return cents / 100;
}
