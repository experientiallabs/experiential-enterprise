import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { processPendingAutoRecharges } from "@/lib/billing/auto-recharge";
import { StripeNotConfiguredError, stripeClient } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

/**
 * The auto-recharge poller. An external scheduler POSTs here on an interval
 * with the shared CRON_SECRET; it drains the queued attempts the balance
 * trigger enqueued and creates one off-session PaymentIntent per attempt.
 * Carries no session and authenticates by the bearer secret, so it lives on
 * the proxy's public-API allowlist the same way the Stripe webhook does.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Auto-recharge poller is not configured." }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const summary = await processPendingAutoRecharges({
      stripe: stripeClient(),
      admin: createServiceRoleSupabaseClient()
    });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`auto-recharge poller failed: ${message}`);
    return NextResponse.json({ error: "Auto-recharge run failed." }, { status: 500 });
  }
}
