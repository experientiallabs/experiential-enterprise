import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { unlockSpendOnCardSaved } from "@/lib/auth/spend-unlock";
import { AUTORECHARGE_PURPOSE, TOPUP_PURPOSE } from "@/lib/billing/constants";
import { sendRechargeEmail } from "@/lib/billing/recharge-email";
import {
  StripeNotConfiguredError,
  stripeClient,
  stripeWebhookSecret
} from "@/lib/billing/stripe";
import { creditsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

// Postgres unique-violation, the ledger's idempotency answer: a replayed
// event's (source, source_ref) insert collides and the row already counted.
const UNIQUE_VIOLATION = "23505";

type ServiceRoleClient = ReturnType<typeof createServiceRoleSupabaseClient>;

/**
 * Stripe's server-to-server callback. Two payment shapes become credits here,
 * each idempotent on its Stripe id and each crediting from Stripe's own
 * amounts, never a client value:
 *   - checkout.session.completed — a manual top-up (source_ref = session id);
 *     if the payer opted into auto-recharge, the saved card is persisted here
 *     too so future off-session charges have something to draw on.
 *   - payment_intent.succeeded / .payment_failed — an off-session auto-recharge
 *     (source_ref = PaymentIntent id), scoped to our purpose marker so a normal
 *     top-up's own payment_intent.succeeded never double-credits.
 * Unrecognized or unpaid events acknowledge with 200 so Stripe stops retrying;
 * a bad signature is 400; a database failure is 500 so Stripe retries later.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let event: Stripe.Event;
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing stripe-signature header." }, { status: 400 });
    }
    const payload = await request.text();
    event = await stripeClient().webhooks.constructEventAsync(
      payload,
      signature,
      stripeWebhookSecret()
    );
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
  }

  // A test event reaching a live deployment (or vice versa) means the Stripe
  // secrets are crossed between environments; every such event is refused
  // loudly instead of silently minting free credits or eating real charges.
  if (event.livemode !== (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_")) {
    return NextResponse.json(
      { error: "Event livemode does not match this deployment's Stripe mode." },
      { status: 400 }
    );
  }

  const admin = createServiceRoleSupabaseClient();
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event.data.object, admin);
    case "payment_intent.succeeded":
      return handleAutoRechargeSucceeded(event.data.object, admin);
    case "payment_intent.payment_failed":
      return handleAutoRechargeFailed(event.data.object, admin);
    default:
      return NextResponse.json({ received: true, handled: false });
  }
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
  admin: ServiceRoleClient
): Promise<Response> {
  // Card-only checkouts complete paid, but guard anyway: an unpaid
  // completion (delayed method sneaking in) must not mint credits.
  if (session.payment_status !== "paid") {
    return NextResponse.json({ received: true, handled: false });
  }
  // Only sessions our checkout route created mint credits: the purpose
  // marker scopes this handler away from any other Checkout flow that ever
  // shares the Stripe account, and the ledger is USD-denominated, so a
  // non-USD session must never record its raw amount as dollars.
  if (session.metadata?.purpose !== TOPUP_PURPOSE || session.currency !== "usd") {
    return NextResponse.json({ received: true, handled: false });
  }
  // Credits are denominated in what the customer bought, which today equals
  // what they paid. The day tax or promo codes turn on, those diverge and
  // "how much credit is $X" becomes a product decision — fail loudly (Stripe
  // retries, the dashboard shows a failing webhook) instead of silently
  // crediting the tax or eating the discount.
  if (
    typeof session.amount_subtotal === "number" &&
    session.amount_subtotal !== session.amount_total
  ) {
    console.error(
      `stripe webhook: session ${session.id} amount_total ${session.amount_total} != amount_subtotal ${session.amount_subtotal}; refusing to guess the credited amount`
    );
    return NextResponse.json({ error: "Unhandled pricing configuration." }, { status: 500 });
  }
  const orgId = session.client_reference_id ?? session.metadata?.org_id ?? null;
  const amountCents = session.amount_total;
  if (!orgId || typeof amountCents !== "number" || amountCents <= 0) {
    // A malformed session (no org, no amount). Acknowledge; there is nothing
    // to credit and retrying will not change that.
    return NextResponse.json({ received: true, handled: false });
  }

  const org = await admin.from("organizations").select("id").eq("id", orgId).maybeSingle();
  if (org.error) {
    // Postgres details stay server-side; the body lands in Stripe's event log.
    console.error(`stripe webhook: org lookup failed: ${org.error.message}`);
    return NextResponse.json({ error: "Ledger write failed." }, { status: 500 });
  }
  if (!org.data) {
    // Paid money for an org that does not exist (deleted mid-checkout).
    // Acknowledge so Stripe stops retrying; the session id in Stripe's
    // dashboard is the trail for a manual refund.
    return NextResponse.json({ received: true, handled: false });
  }

  // Deliberately NOT audited (enterprise audit trail): the credit_ledger row
  // inserted here IS the durable, attributed record of this mutation (source,
  // source_ref, created_by), so an audit event would duplicate it.
  const insert = await admin.from("credit_ledger").insert({
    org_id: orgId,
    entry_type: "topup",
    amount_usd: amountCents / 100,
    reason: "Credit top-up",
    source: "stripe",
    source_ref: session.id,
    created_by: session.metadata?.requested_by ?? null
  });
  if (insert.error && insert.error.code !== UNIQUE_VIOLATION) {
    console.error(`stripe webhook: ledger insert failed: ${insert.error.message}`);
    return NextResponse.json({ error: "Ledger write failed." }, { status: 500 });
  }
  const replay = insert.error?.code === UNIQUE_VIOLATION;

  // Persist the saved card on the SAME event that saved it, whether or not the
  // credit was a replay: a retried webhook must still converge the settings.
  if (session.metadata?.autorecharge === "on") {
    await persistAutoRecharge(session, orgId, admin);
  }
  return NextResponse.json(replay ? { received: true, handled: true, replay: true } : { received: true, handled: true });
}

/**
 * After a consented top-up, read the saved customer + payment method off the
 * session's PaymentIntent and upsert the org's auto-recharge settings. Best
 * effort: a failure here leaves the credit intact and only means auto-recharge
 * is not armed yet, so it is logged, never surfaced as a webhook error.
 */
async function persistAutoRecharge(
  session: Stripe.Checkout.Session,
  orgId: string,
  admin: ServiceRoleClient
): Promise<void> {
  try {
    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : null;
    const customerId = typeof session.customer === "string" ? session.customer : null;
    if (!paymentIntentId || !customerId) {
      console.error(`stripe webhook: session ${session.id} opted into auto-recharge without a customer/payment intent`);
      return;
    }
    const intent = await stripeClient().paymentIntents.retrieve(paymentIntentId);
    const paymentMethodId =
      typeof intent.payment_method === "string"
        ? intent.payment_method
        : (intent.payment_method?.id ?? null);
    if (!paymentMethodId) {
      console.error(`stripe webhook: payment intent ${paymentIntentId} carries no saved payment method`);
      return;
    }
    const threshold = Number(session.metadata?.autorecharge_threshold_usd);
    const amount = Number(session.metadata?.autorecharge_amount_usd);
    const notifyEmail = session.customer_details?.email ?? null;
    const upsert = await admin.from("org_auto_recharge_settings").upsert(
      {
        org_id: orgId,
        enabled: true,
        ...(Number.isFinite(threshold) ? { threshold_usd: threshold } : {}),
        ...(Number.isFinite(amount) ? { amount_usd: amount } : {}),
        stripe_customer_id: customerId,
        stripe_payment_method_id: paymentMethodId,
        notify_email: notifyEmail,
        // A freshly saved card clears any prior decline back-off.
        consecutive_failures: 0,
        last_failure_at: null,
        last_failure_message: null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "org_id" }
    );
    if (upsert.error) {
      console.error(`stripe webhook: auto-recharge settings upsert failed: ${upsert.error.message}`);
      return;
    }
    // The card is now saved for this org. When the platform is in 'card' spend-
    // unlock mode (app_settings.spend_unlock_requirement), a saved card is the
    // proof that opens the P1025 credit gate; in the default 'email' mode this is
    // a no-op, so today nothing changes. Best-effort, like the settings upsert.
    await unlockSpendOnCardSaved(admin, orgId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`stripe webhook: persisting auto-recharge settings failed: ${message}`);
  }
}

async function handleAutoRechargeSucceeded(
  intent: Stripe.PaymentIntent,
  admin: ServiceRoleClient
): Promise<Response> {
  // Only OUR off-session recharges: a normal top-up's payment_intent.succeeded
  // carries no purpose marker and was already credited from the checkout event.
  if (intent.metadata?.purpose !== AUTORECHARGE_PURPOSE || intent.currency !== "usd") {
    return NextResponse.json({ received: true, handled: false });
  }
  const orgId = intent.metadata?.org_id ?? null;
  const amountCents = intent.amount_received || intent.amount;
  if (!orgId || typeof amountCents !== "number" || amountCents <= 0) {
    return NextResponse.json({ received: true, handled: false });
  }

  const result = await admin.rpc("record_auto_recharge_success", {
    in_org: orgId,
    in_payment_intent_id: intent.id,
    in_amount_usd: amountCents / 100,
    in_created_by: "auto-recharge"
  });
  if (result.error) {
    console.error(`stripe webhook: record_auto_recharge_success failed: ${result.error.message}`);
    return NextResponse.json({ error: "Ledger write failed." }, { status: 500 });
  }
  const replay = result.data === "replay";
  if (!replay) {
    // Best-effort calm notice; the credit is already recorded regardless.
    await notifyRecharge(orgId, amountCents / 100, admin);
  }
  return NextResponse.json(
    replay ? { received: true, handled: true, replay: true } : { received: true, handled: true }
  );
}

async function handleAutoRechargeFailed(
  intent: Stripe.PaymentIntent,
  admin: ServiceRoleClient
): Promise<Response> {
  if (intent.metadata?.purpose !== AUTORECHARGE_PURPOSE) {
    return NextResponse.json({ received: true, handled: false });
  }
  const orgId = intent.metadata?.org_id ?? null;
  if (!orgId) {
    return NextResponse.json({ received: true, handled: false });
  }
  const message = intent.last_payment_error?.message ?? "The card was declined.";
  const result = await admin.rpc("record_auto_recharge_failure", {
    in_org: orgId,
    in_payment_intent_id: intent.id,
    in_message: message
  });
  if (result.error) {
    console.error(`stripe webhook: record_auto_recharge_failure failed: ${result.error.message}`);
    return NextResponse.json({ error: "Ledger write failed." }, { status: 500 });
  }
  return NextResponse.json({ received: true, handled: true });
}

async function notifyRecharge(
  orgId: string,
  amountUsd: number,
  admin: ServiceRoleClient
): Promise<void> {
  const settings = await admin
    .from("org_auto_recharge_settings")
    .select("notify_email")
    .eq("org_id", orgId)
    .maybeSingle();
  const email = settings.data?.notify_email ?? null;
  if (!email) {
    return;
  }
  const org = await admin
    .from("organizations")
    .select("name, credit_granted_usd, billable_spend_usd")
    .eq("id", orgId)
    .maybeSingle();
  if (!org.data) {
    return;
  }
  const balance = Number(org.data.credit_granted_usd) - Number(org.data.billable_spend_usd);
  const origin = process.env.EXPLABS_WEBAPP_URL ?? "https://platform.experientiallabs.ai";
  const result = await sendRechargeEmail({
    to: email,
    orgName: org.data.name ?? "your organization",
    amountUsd,
    newBalanceUsd: balance,
    creditsUrl: `${origin}${creditsPath()}`
  });
  if (!result.sent) {
    console.error(`stripe webhook: recharge email not sent: ${result.reason}`);
  }
}
