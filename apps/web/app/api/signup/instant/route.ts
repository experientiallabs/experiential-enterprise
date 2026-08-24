import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { provisionInstantAccount } from "@/lib/auth/instant-signup";
import { requestOrigin, safePrefillEmail } from "@/lib/auth/redirects";
import { isSignupAllowed, SIGNUP_DISABLED_MESSAGE } from "@/lib/auth/signup-gate";
import { allowEmailSend, allowSignupStart, clientIp } from "@/lib/auth/signup-rate-limit";
import { sendVerificationEmail } from "@/lib/auth/verification";
import { jsonError, jsonOk } from "@/lib/http";
import { overviewPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

// Instant, hands-off account creation for a coding agent. A founder pastes the
// trace-onboarding prompt; their agent asks them for their email and POSTs
// it here, getting back a working `xpl_` org key IMMEDIATELY — no browser, no
// device code, no password. The account is created UNVERIFIED and can do
// everything (wire the gateway, upload/pull traces as telemetry, read the
// dashboard) EXCEPT draw platform credits.
//
// The $20 welcome grant is applied at signup and shown immediately, but LOCKED
// by the spend gate (P1025, keyed on organizations.spend_unlocked_at) until the
// owner unlocks spend by verifying their inbox. This key belongs to the FOUNDER,
// so it SURVIVES unlock (migration 20260827000000) and keeps working through and
// after verification — a legitimate user's wired key is never killed. The primary
// credit-theft defense is the spend gate itself; at unlock only attacker-added
// NON-founder members are rotated. BYOK is never gated. Provisioning and the
// accepted residual risk live in lib/auth/instant-signup.

function parseEmail(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Signup request must be a JSON object.");
  }
  const raw = (payload as { email?: unknown }).email;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Signup request must include an email.");
  }
  const email = safePrefillEmail(raw);
  if (email === null) {
    throw new Error("That email address is not valid.");
  }
  return email;
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    let email: string;
    try {
      email = parseEmail(await request.json());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid signup request.";
      return NextResponse.json({ code: "invalid_request", error: message }, { status: 400 });
    }

    if (!allowSignupStart(clientIp(request))) {
      return NextResponse.json(
        { code: "rate_limited", error: "Too many signups from this address; try again shortly." },
        { status: 429 }
      );
    }

    const admin = createServiceRoleSupabaseClient();

    // Same platform-wide gate the browser signup honors; fails closed if the
    // service role cannot read it, so a misconfiguration never opens signups.
    let allowed: boolean;
    try {
      allowed = await isSignupAllowed(admin, email, null);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return NextResponse.json(
        { code: "signup_disabled", error: SIGNUP_DISABLED_MESSAGE },
        { status: 403 }
      );
    }

    const result = await provisionInstantAccount(admin, email, null, "Coding agent (instant signup)");
    if (result.status === "account_exists") {
      // A known address must NOT yield a key: that would hand an existing org's
      // access to anyone who knows the email. Point them at sign-in instead.
      return NextResponse.json(
        {
          code: "account_exists",
          error: "An account already exists for this email. Sign in to get an API key."
        },
        { status: 409 }
      );
    }
    if (result.status === "signup_failed") {
      return NextResponse.json({ code: "signup_failed", error: result.message }, { status: 500 });
    }

    // Send the verification email (admin-generated magic link via Resend, so
    // delivery does not depend on GoTrue's SMTP config). Clicking it proves inbox
    // ownership — setting organizations.spend_unlocked_at — which opens the spend
    // gate with no further action. Non-fatal: the account and key already work
    // for everything except spending, so a mailer hiccup must not fail the signup.
    const origin = requestOrigin(request);
    const verification = allowEmailSend(email)
      ? await sendVerificationEmail(admin, email, origin)
      : { sent: false as const, reason: "email cooldown" };
    if (!verification.sent) {
      console.error(`instant signup: verification email failed for ${email}: ${verification.reason}`);
    }

    return jsonOk({
      api_key: result.apiKeySecret,
      org_id: result.orgId,
      credits_granted: result.creditsGranted,
      verification_required: true,
      verification_email_sent: verification.sent,
      // The public web origin from the request, never the pod's dev bind address.
      overview_url: new URL(overviewPath(), origin).toString()
    });
  } catch (error) {
    return jsonError(error);
  }
}
