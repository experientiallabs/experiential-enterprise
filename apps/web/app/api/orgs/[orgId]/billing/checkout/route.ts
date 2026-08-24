import { NextResponse, type NextRequest } from "next/server";
import Stripe from "stripe";

import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { requireAuthenticatedUser } from "@/lib/auth/server";
import {
  DEFAULT_AUTORECHARGE_AMOUNT_USD,
  DEFAULT_AUTORECHARGE_THRESHOLD_USD
} from "@/lib/billing/constants";
import {
  StripeNotConfiguredError,
  TOPUP_PURPOSE,
  parseAutoRechargeThresholdUsd,
  parseTopupAmountUsd,
  stripeClient
} from "@/lib/billing/stripe";
import { requireOrg } from "@/lib/data-cache";
import { jsonError } from "@/lib/http";
import { creditsPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ orgId: string }>;
};

/**
 * Start a credit top-up: create a Stripe Checkout session for the requested
 * amount and hand back its URL. Credits land when the webhook receives the
 * session's completion — never here, so an abandoned checkout leaves no
 * trace. Card-only and one-time on purpose: delayed payment methods would
 * split "paid" from "completed" and v1 does not carry that state.
 */
export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const { orgId } = await context.params;
    const user = await requireAuthenticatedUser();
    const org = await requireOrg(orgId);
    const canManage = (await isPlatformAdmin()) || (await isOrgAdmin(user.id, org.id));
    if (!canManage) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as {
      amount_usd?: unknown;
      auto_recharge?: { enabled?: unknown; threshold_usd?: unknown; amount_usd?: unknown } | null;
    } | null;
    const amount = parseTopupAmountUsd(body?.amount_usd);
    if (typeof amount !== "number") {
      return NextResponse.json({ error: amount.error }, { status: 400 });
    }

    // Auto-recharge consent (checked by default in the UI): when on, the
    // Checkout saves the card off-session and the webhook persists the settings
    // once the payment lands. The recharge amount reuses the top-up bounds; the
    // threshold gets its own (it may be $0). Absent or off leaves a plain
    // one-time top-up that saves no card.
    const consent = body?.auto_recharge ?? null;
    const wantsAutoRecharge = consent?.enabled === true;
    let autoRechargeAmount = DEFAULT_AUTORECHARGE_AMOUNT_USD;
    let autoRechargeThreshold = DEFAULT_AUTORECHARGE_THRESHOLD_USD;
    if (wantsAutoRecharge) {
      if (consent?.amount_usd !== undefined) {
        const parsed = parseTopupAmountUsd(consent.amount_usd);
        if (typeof parsed !== "number") {
          return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        autoRechargeAmount = parsed;
      }
      if (consent?.threshold_usd !== undefined) {
        const parsed = parseAutoRechargeThresholdUsd(consent.threshold_usd);
        if (typeof parsed !== "number") {
          return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        autoRechargeThreshold = parsed;
      }
    }

    // Anchor the post-payment redirect to the configured public URL when one
    // is set: request.url reflects the incoming Host header, and a forged
    // Host would otherwise steer the payer to an attacker page after paying.
    const origin = process.env.EXPLABS_WEBAPP_URL ?? new URL(request.url).origin;
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      // Saving the card off-session needs a Customer to attach it to. Only
      // created when the payer opts in, so a plain top-up leaves no customer.
      ...(wantsAutoRecharge
        ? {
            customer_creation: "always" as const,
            payment_intent_data: { setup_future_usage: "off_session" as const }
          }
        : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amount * 100),
            product_data: {
              name: "Platform credits",
              description: `$${amount.toFixed(2)} of prepaid serving and optimization credit for ${org.name}`
            }
          }
        }
      ],
      // The webhook credits by org_id + the purpose marker; the ledger's
      // unique (source, source_ref) makes a replayed event a no-op. The
      // autorecharge_* metadata is what the webhook persists to settings once
      // the card is saved.
      client_reference_id: org.id,
      metadata: {
        purpose: TOPUP_PURPOSE,
        org_id: org.id,
        requested_by: user.id,
        autorecharge: wantsAutoRecharge ? "on" : "off",
        ...(wantsAutoRecharge
          ? {
              autorecharge_threshold_usd: String(autoRechargeThreshold),
              autorecharge_amount_usd: String(autoRechargeAmount)
            }
          : {})
      },
      success_url: `${origin}${creditsPath()}?topup=success`,
      cancel_url: `${origin}${creditsPath()}?topup=cancelled`
    });
    if (!session.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout URL." },
        { status: 502 }
      );
    }
    return NextResponse.json({ url: session.url });
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof Stripe.errors.StripeError) {
      // Stripe error messages confirm key mode and parameter internals;
      // the detail stays server-side.
      console.error(`stripe checkout: ${error.type}: ${error.message}`);
      return NextResponse.json({ error: "The payment provider refused the request." }, {
        status: 502
      });
    }
    return jsonError(error);
  }
}
