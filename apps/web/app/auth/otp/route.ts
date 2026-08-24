import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { requestOrigin, safePrefillEmail } from "@/lib/auth/redirects";
import { createRouteSupabaseClient } from "@/lib/auth/server";
import { isSignupAllowed } from "@/lib/auth/signup-gate";
import { allowEmailSend, releaseEmailSend } from "@/lib/auth/signup-rate-limit";

// Requests a 6-digit email sign-in code (GoTrue signInWithOtp) — the default
// email flow behind /signin and the login modal; /auth/otp/verify turns the
// code into a session. DELIBERATELY NEUTRAL: unlike /auth/signin (whose
// confirm-create step openly distinguishes accounts), this endpoint answers
// the same 200 whether the address has an account, can sign up, or is gated
// off — an unsendable address simply never receives a code and fails at
// verify. Only rate limiting and mailer failures surface, since they reveal
// nothing about the account:
//
//   200 { ok }                        code sent — or silently not, when gated
//   429 { code: "rate_limited" }      GoTrue's email send frequency cap
//   400 { code: "invalid_request" }   malformed email/body
//   502 { code: "otp_send_failed" }   the mailer itself failed
type OtpPayload = {
  email: string;
  inviteToken: string | null;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);
  const emailRedirectTo = new URL("/auth/callback", requestOrigin(request)).toString();

  let payload: OtpPayload;
  try {
    payload = parseOtpPayload(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ code: "invalid_request", error: message }, { status: 400 });
  }

  // The same invite/signups_enabled gate as /auth/signin, fails closed. The
  // gate only decides shouldCreateUser: an EXISTING account always gets its
  // code, so a gated deployment never locks current users out of email login.
  const allowSignup = await signupAllowed(payload.email, payload.inviteToken);
  if (!allowEmailSend(payload.email)) {
    return NextResponse.json(
      {
        code: "rate_limited",
        error: "A code was sent recently. Check your inbox, or wait a minute and try again."
      },
      { status: 429 }
    );
  }
  let otpResult: Awaited<ReturnType<typeof supabase.auth.signInWithOtp>>;
  try {
    otpResult = await supabase.auth.signInWithOtp({
      email: payload.email,
      options: {
        shouldCreateUser: allowSignup,
        emailRedirectTo,
        // The invite token rides as signup metadata exactly like the password
        // path; the database provisioning trigger consumes it on creation.
        ...(payload.inviteToken ? { data: { invite_token: payload.inviteToken } } : {})
      }
    });
  } catch {
    releaseEmailSend(payload.email);
    return NextResponse.json(
      { code: "otp_send_failed", error: "Couldn't send the code. Try again, or use a password." },
      { status: 502 }
    );
  }
  const { error } = otpResult;
  if (error !== null) {
    releaseEmailSend(payload.email);
    if (error.status === 429) {
      return NextResponse.json(
        {
          code: "rate_limited",
          error: "A code was sent recently. Check your inbox, or wait a minute and try again."
        },
        { status: 429 }
      );
    }
    // GoTrue's "signups not allowed for otp" — the no-account-and-gated case.
    // Answering 200 here is the whole point: no account-existence oracle.
    if (error.code === "otp_disabled" || error.status === 422) {
      return response;
    }
    return NextResponse.json(
      { code: "otp_send_failed", error: "Couldn't send the code. Try again, or use a password." },
      { status: 502 }
    );
  }
  return response;
}

async function signupAllowed(email: string, inviteToken: string | null): Promise<boolean> {
  try {
    return await isSignupAllowed(createServiceRoleSupabaseClient(), email, inviteToken);
  } catch {
    return false;
  }
}

function parseOtpPayload(value: unknown): OtpPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const email = typeof payload.email === "string" ? safePrefillEmail(payload.email) : null;
  if (email === null) {
    throw new Error("A valid email is required.");
  }
  const inviteToken = payload.inviteToken;
  if (inviteToken !== undefined && inviteToken !== null && typeof inviteToken !== "string") {
    throw new Error("Invite token must be a string.");
  }
  const trimmedToken = typeof inviteToken === "string" ? inviteToken.trim() : "";
  return { email, inviteToken: trimmedToken.length > 0 ? trimmedToken : null };
}
