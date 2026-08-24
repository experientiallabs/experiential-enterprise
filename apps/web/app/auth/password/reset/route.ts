import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { requestOrigin, safePrefillEmail } from "@/lib/auth/redirects";
import { allowEmailSend } from "@/lib/auth/signup-rate-limit";
import { sendPasswordResetEmail } from "@/lib/auth/verification";

export const dynamic = "force-dynamic";

// Requests a password-RESET / set-password email. Password sign-in is an OPTIONAL
// alternative to the passwordless default; a user who wants one (or forgot it)
// asks here, proves inbox ownership via the emailed recovery link, and sets a
// password on the resulting recovery session (/auth/password/reset/confirm).
//
// DELIBERATELY NEUTRAL: always answers 200 regardless of whether the address has
// an account or the mailer succeeded, so it is no account-existence oracle
// (matching /auth/otp). Per-address cooldown (allowEmailSend) blunts inbox
// blasting; the email itself goes out via admin generateLink(type=recovery) +
// Resend, the same verified path the signup verification email uses.
//
//   200 { ok }                       accepted (sent, or silently not)
//   400 { code:"invalid_request" }   malformed email/body
type ResetPayload = { email: string };

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload: ResetPayload;
  try {
    payload = parseResetPayload(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ code: "invalid_request", error: message }, { status: 400 });
  }

  if (allowEmailSend(payload.email)) {
    try {
      const admin = createServiceRoleSupabaseClient();
      const result = await sendPasswordResetEmail(admin, payload.email, requestOrigin(request));
      if (!result.sent) {
        // Swallowed: reporting a send failure would leak whether the address
        // exists. Logged for operators.
        console.error(`password reset: email failed for ${payload.email}: ${result.reason}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`password reset: unexpected failure for ${payload.email}: ${message}`);
    }
  }

  return NextResponse.json({ ok: true });
}

function parseResetPayload(value: unknown): ResetPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request must be an object.");
  }
  const email =
    typeof (value as { email?: unknown }).email === "string"
      ? safePrefillEmail((value as { email: string }).email)
      : null;
  if (email === null) {
    throw new Error("A valid email is required.");
  }
  return { email };
}
