import { NextResponse, type NextRequest } from "next/server";

import { hasRecoveryAuthMethod, parseResetPassword } from "@/lib/auth/password";
import {
  passwordRecoveryCookieOptions,
  PASSWORD_RECOVERY_COOKIE,
  recoverySessionIdentity,
  verifyPasswordRecoveryTicket
} from "@/lib/auth/password-recovery";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Sets a new password on a RECOVERY session (the emailed reset link, consumed by
// /auth/callback). No current password is required — possession of the emailed
// link is the proof. GoTrue records admin-generated recovery links as `otp`, so
// the route requires BOTH a compatible email-link `amr` and the signed,
// session-bound ticket minted by /auth/callback. An ordinary OTP or live session
// therefore cannot reach updateUser and silently plant a password.
//
//   200 { ok }                       password set; refreshed session rides back
//   400 { code:"invalid_request" }   malformed body
//   400 { code:"weak_password" }     shorter than the minimum
//   401 { code:"no_recovery" }       not a recovery session (expired / wrong)
//   422 { error }                    GoTrue refused the update
export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);

  let password: string;
  try {
    ({ password } = parseResetPassword(await request.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    const code = message.toLowerCase().includes("at least") ? "weak_password" : "invalid_request";
    return NextResponse.json({ code, error: message }, { status: 400 });
  }

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const identity = recoverySessionIdentity(claimsData?.claims);
  if (
    claimsError ||
    identity === null ||
    !hasRecoveryAuthMethod(claimsData?.claims) ||
    !verifyPasswordRecoveryTicket(
      request.cookies.get(PASSWORD_RECOVERY_COOKIE)?.value,
      identity
    )
  ) {
    return NextResponse.json(
      { code: "no_recovery", error: "This reset link has expired. Request a new one." },
      { status: 401 }
    );
  }

  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    return NextResponse.json(
      { error: "Unable to set the password. Please try again." },
      { status: 422 }
    );
  }

  // updateUser rotates the session; carry the refreshed cookies onto a fresh
  // response so the caller stays signed in with the new credential.
  const successResponse = carryAuthCookies(response, NextResponse.json({ ok: true }));
  successResponse.cookies.set(PASSWORD_RECOVERY_COOKIE, "", {
    ...passwordRecoveryCookieOptions(),
    maxAge: 0
  });
  return successResponse;
}
