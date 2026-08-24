import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { safePrefillEmail } from "@/lib/auth/redirects";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";
import { unlockSpendOnInboxProof } from "@/lib/auth/spend-unlock";

// Turns an emailed 6-digit code (from /auth/otp) into a session:
//
//   200 { ok, created }              signed in; `created` says this code also
//                                    created the account (drives the form's
//                                    post-login destination, like /auth/signin)
//   400 { code: "otp_invalid" }      wrong or expired code
//   400 { code: "invalid_request" }  malformed email/body
type VerifyPayload = {
  email: string;
  token: string;
};

// An OTP-created account is created at code-request time, so its created_at
// falls inside the code's own validity window. Wider than any real window to
// absorb clock skew; misclassifying only changes the post-login landing page.
const CREATED_WINDOW_MS = 30 * 60 * 1000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true, created: false });
  const supabase = createRouteSupabaseClient(request, response);

  let payload: VerifyPayload;
  try {
    payload = parseVerifyPayload(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return NextResponse.json({ code: "invalid_request", error: message }, { status: 400 });
  }

  const { data, error } = await supabase.auth.verifyOtp({
    email: payload.email,
    token: payload.token,
    type: "email"
  });
  if (error !== null || data.user === null) {
    return NextResponse.json(
      { code: "otp_invalid", error: "That code is invalid or has expired. Request a new one." },
      { status: 400 }
    );
  }
  // Entering the emailed code proves inbox ownership, so unlock credit spending
  // for the user's org(s) — the decoupled signal the P1025 gate reads, which also
  // rotates any pre-unlock credentials. Best-effort; never fails the sign-in.
  // Routes on app_settings.spend_unlock_requirement: inbox proof unlocks in the
  // default 'email' mode; in 'card' mode a saved card is required instead.
  await unlockSpendOnInboxProof(createServiceRoleSupabaseClient(), data.user.id);

  const createdAt = Date.parse(data.user.created_at);
  const created = Number.isFinite(createdAt) && Date.now() - createdAt < CREATED_WINDOW_MS;
  return carryAuthCookies(response, NextResponse.json({ ok: true, created }));
}

function parseVerifyPayload(value: unknown): VerifyPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const email = typeof payload.email === "string" ? safePrefillEmail(payload.email) : null;
  if (email === null) {
    throw new Error("A valid email is required.");
  }
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!/^\d{6}$/.test(token)) {
    throw new Error("The sign-in code is 6 digits.");
  }
  return { email, token };
}
