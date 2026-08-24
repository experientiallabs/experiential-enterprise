// Billing constants importable from CLIENT components: lib/billing/stripe.ts
// pulls in the Stripe SDK at module top, so the UI reads bounds from here.

// Provenance marker on every Checkout session this app creates. The webhook
// credits ONLY sessions carrying it: any other Checkout flow that ever shares
// this Stripe account (a different product, a manual dashboard sale) must not
// mint platform credits just because its reference id collides with an org.
export const TOPUP_PURPOSE = "platform-credit-topup";

// Credit top-up bounds. The floor keeps card-fee overhead sane; the ceiling
// is a fat-finger guard, not a product limit (support can grant any amount).
export const MIN_TOPUP_USD = 5;
export const MAX_TOPUP_USD = 10_000;

// One-click amounts on the add-credits form; a custom input covers the rest.
export const TOPUP_PRESETS_USD = [25, 100, 500] as const;

// Provenance marker on the off-session PaymentIntents auto-recharge creates.
// The webhook credits payment_intent.succeeded ONLY when it carries this: a
// normal Checkout top-up also emits a payment_intent.succeeded, and that one is
// already credited from checkout.session.completed, so the two markers keep the
// same card charge from minting credit twice.
export const AUTORECHARGE_PURPOSE = "platform-credit-autorecharge";

// Auto-recharge defaults (the product owner's decision): a small $5 top-up, offered opted
// in, fired when the balance drops below $10. Both are adjustable per org.
export const DEFAULT_AUTORECHARGE_AMOUNT_USD = 5;
export const DEFAULT_AUTORECHARGE_THRESHOLD_USD = 10;

// The recharge amount reuses the top-up floor/ceiling (card-fee sanity, a
// fat-finger guard). The threshold only needs to be a non-negative dollar
// figure; the ceiling keeps a typo from arming a recharge that fires forever.
export const MIN_AUTORECHARGE_THRESHOLD_USD = 0;
export const MAX_AUTORECHARGE_THRESHOLD_USD = 10_000;

// The sanitized auto-recharge state the settings API returns to the client.
// The Stripe customer/payment-method ids never cross this boundary: the UI
// only needs to know whether a card is on file (hasPaymentMethod) and whether
// the last attempt is currently failing.
export type AutoRechargeSettings = {
  enabled: boolean;
  thresholdUsd: number;
  amountUsd: number;
  hasPaymentMethod: boolean;
  lastRechargeAt: string | null;
  /** Non-zero after a decline; the UI shows a "recharge failed" state. */
  consecutiveFailures: number;
  lastFailureMessage: string | null;
};
