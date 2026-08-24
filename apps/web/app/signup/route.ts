import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { requestOrigin, safePrefillEmail } from "@/lib/auth/redirects";
import { isSignupAllowed } from "@/lib/auth/signup-gate";
import {
  allowEmailSend,
  allowSignupStart,
  clientIp,
  releaseEmailSend
} from "@/lib/auth/signup-rate-limit";
import { sendSigninCode, sendSignupCode } from "@/lib/auth/verification";
import { signinPath } from "@/lib/routes";

export const dynamic = "force-dynamic";

// The marketing website's "Get API key": the browser lands here with the
// visitor's email (`/signup?email=`), and this entry hands them to the
// passwordless six-digit code flow.
//
//   NEW email  -> send a code and bounce to /signin's "enter the code" state;
//     the code creates the org when the visitor verifies it. The code is the
//     inbox proof and opens the existing welcome reveal (`/overview?welcome=1`).
//   EXISTING email -> never auto-login (that would be account takeover): send an
//     emailed sign-in code and bounce to /signin's "enter the code" state, so
//     the visitor proves inbox ownership before any session.
//   No or invalid email -> fall back to the passwordless /signin form.
//
// ENUMERATION (accepted risk): a NEW email redirects to /signin?sent=1&signup=1
// while an EXISTING one redirects to /signin?sent=1, which reveals whether an
// address is a customer. The marketing UX needs this distinction, so per the
// security review it is accepted and bounded by the per-IP limit and per-address
// email cooldown below (an attacker cannot cheaply probe at scale or blast an
// inbox). The account-existence-neutral path remains /auth/otp on /signin.

function bounceToSignin(
  origin: string,
  email: string,
  params: Record<string, string>
): NextResponse {
  const url = new URL(signinPath(), origin);
  url.searchParams.set("email", email);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, { status: 303 });
}

// null means "could not check" (missing service key, GoTrue hiccup); the caller
// treats it conservatively as "let them sign in" rather than risk a duplicate.
async function emailHasAccount(email: string): Promise<boolean | null> {
  try {
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.rpc("signin_methods_for_email", { check_email: email });
    if (error !== null || !Array.isArray(data)) {
      return null;
    }
    return data.length > 0;
  } catch {
    return null;
  }
}

async function signupAllowed(email: string): Promise<boolean> {
  try {
    return await isSignupAllowed(createServiceRoleSupabaseClient(), email, null);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const origin = requestOrigin(request);
  const email = safePrefillEmail(request.nextUrl.searchParams.get("email"));
  // No usable email: fall back to the passwordless sign-in form.
  if (email === null) {
    return NextResponse.redirect(new URL(signinPath(), origin), { status: 303 });
  }

  if (!allowSignupStart(clientIp(request))) {
    return bounceToSignin(origin, email, { error: "rate_limited" });
  }

  // Existing account -> send an emailed sign-in code and land on "check your
  // email"; never auto-login. Unknown (lookup failed) is treated the same, so a
  // transient error can never create a duplicate for an address that has one.
  const exists = await emailHasAccount(email);
  if (exists === true || exists === null) {
    if (!allowEmailSend(email)) {
      return bounceToSignin(origin, email, { error: "rate_limited" });
    }
    const sent = await sendSigninCode(email, origin);
    if (!sent) {
      releaseEmailSend(email);
    }
    return bounceToSignin(origin, email, {
      ...(sent ? { sent: "1" } : { error: "otp_send_failed" })
    });
  }

  // New account: only send a creating code when signups are open. The code
  // request is still gate-checked by GoTrue and the verification route, while
  // this entry remains bounded by the same per-IP and per-address controls.
  if (!(await signupAllowed(email))) {
    return bounceToSignin(origin, email, { error: "signup_disabled" });
  }
  if (!allowEmailSend(email)) {
    return bounceToSignin(origin, email, { error: "rate_limited", signup: "1" });
  }
  const sent = await sendSignupCode(email, origin);
  if (!sent) {
    releaseEmailSend(email);
  }
  return bounceToSignin(origin, email, {
    ...(sent ? { sent: "1" } : { error: "otp_send_failed" }),
    signup: "1"
  });
}
