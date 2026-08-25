import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { safePrefillEmail } from "@/lib/auth/redirects";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";
import { signinMethodsForEmail } from "@/lib/auth/signin-methods";
import { allowSigninAttempt, clientIp } from "@/lib/auth/signup-rate-limit";

export const dynamic = "force-dynamic";

// Password sign-in — the OPTIONAL alternative to the passwordless default. Auth
// stays passwordless-first (OAuth + emailed 6-digit code); a user only reaches
// here if they set a real password through the reset/set-password flow
// (/auth/password/reset). Signup never sets a user-known password, so a fresh
// account has none until it opts in.
//
//   200 { ok, created:false }      signed in; the session cookies ride back
//   401 { code:"no_account" }      no account exists for that email
//   401 { code:"wrong_password" }  the account exists but the password was
//                                  rejected (also covers a passwordless account
//                                  that has never set a password; the UI then
//                                  offers reset AND the emailed-code path)
//   429 { code:"rate_limited" }    per-IP / per-address attempt limit
//   400 { code:"invalid_request" } malformed email/body
//
// The 401 DELIBERATELY distinguishes account existence (owner decision,
// 2026-08-24): a rejected sign-in now tells the caller whether to create an
// account or fix a wrong password, instead of the old uniform message. This is
// the same bounded-enumeration posture already accepted on /signup: it leaks
// account existence, so it is bounded by the per-IP + per-address attempt limits
// (lib/auth/signup-rate-limit). The emailed-code path (/auth/otp) STAYS
// account-existence-neutral; only this password path distinguishes.
type SigninPayload = {
  email: string;
  password: string;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true, created: false });
  const supabase = createRouteSupabaseClient(request, response);

  let payload: SigninPayload;
  try {
    payload = parseSigninPayload(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ code: "invalid_request", error: message }, { status: 400 });
  }

  // The distinguishing 401 below is an account-existence oracle, so bound it the
  // same way signup is: per-IP (caps cross-address probing) and per-address
  // (blunts brute-forcing one account). Attempted before touching GoTrue so a
  // limited caller cannot even test a credential.
  if (!allowSigninAttempt(clientIp(request), payload.email)) {
    return NextResponse.json(
      { code: "rate_limited", error: "Too many sign-in attempts; try again shortly." },
      { status: 429 }
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: payload.email,
    password: payload.password
  });
  if (error !== null || data.user === null) {
    // Distinguish "no account" from "wrong password" using the same service-role
    // lookup the marketing signup uses (signin_methods_for_email). An
    // inconclusive lookup (null result, or the service-role client itself
    // failing to construct on a misconfigured pod) falls back to wrong_password
    // so a transient internal failure never manufactures a "no account" signal
    // for an address that may well exist. The construction is inside the try so
    // a missing SUPABASE_SERVICE_ROLE_KEY degrades to the fallback, not a 500.
    let methods: Awaited<ReturnType<typeof signinMethodsForEmail>> = null;
    try {
      methods = await signinMethodsForEmail(createServiceRoleSupabaseClient(), payload.email);
    } catch {
      methods = null;
    }
    if (methods !== null && methods.length === 0) {
      return NextResponse.json(
        { code: "no_account", error: "No account found for that email." },
        { status: 401 }
      );
    }
    return NextResponse.json({ code: "wrong_password", error: "Wrong password." }, { status: 401 });
  }

  // Carry the Supabase Set-Cookie writes (session) onto a fresh ok response,
  // exactly like /auth/otp/verify.
  return carryAuthCookies(response, NextResponse.json({ ok: true, created: false }));
}

function parseSigninPayload(value: unknown): SigninPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const email = typeof payload.email === "string" ? safePrefillEmail(payload.email) : null;
  if (email === null) {
    throw new Error("A valid email is required.");
  }
  const password = typeof payload.password === "string" ? payload.password : "";
  if (password.length === 0) {
    throw new Error("A password is required.");
  }
  return { email, password };
}
