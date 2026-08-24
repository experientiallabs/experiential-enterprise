import { NextResponse, type NextRequest } from "next/server";

import { createServiceRoleSupabaseClient } from "@/lib/auth/admin";
import { authenticatedUserFromClaims } from "@/lib/auth/claims";
import {
  canChangePasswordForSession,
  emailHasPassword,
  hasPasswordIdentity,
  parseChangePasswordPayload
} from "@/lib/auth/password";
import { createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  const supabase = createRouteSupabaseClient(request, response);

  try {
    const payload = parseChangePasswordPayload(await request.json());
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    const claims = claimsData?.claims;
    const user = claims ? authenticatedUserFromClaims(claims) : null;
    if (claimsError || user === null) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    if (user.email === null) {
      return NextResponse.json(
        { error: "This account does not have an email/password sign-in to change." },
        { status: 422 }
      );
    }
    const { data: authUserData, error: authUserError } = await supabase.auth.getUser();
    if (authUserError || authUserData.user?.id !== user.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    // FIRST password for a passwordless (email-code) account: there is no
    // current credential to prove, so the authenticated session is the proof.
    // Gated on a verified no-password state — an account that has one always
    // proves it below — and on an email identity, so OAuth-only accounts keep
    // their explicit 422 instead of quietly growing a password login.
    if (
      hasPasswordIdentity(authUserData.user) &&
      (await checkEmailHasPassword(user.email)) === false
    ) {
      const { error: setError } = await supabase.auth.updateUser({
        password: payload.newPassword
      });
      if (setError) {
        return NextResponse.json(
          { error: "Unable to set the password. Please try again." },
          { status: 422 }
        );
      }
      return response;
    }

    if (!canChangePasswordForSession(authUserData.user, claims)) {
      return NextResponse.json(
        { error: "This account does not have an email/password sign-in to change." },
        { status: 422 }
      );
    }
    if (payload.currentPassword === null) {
      return NextResponse.json({ error: "Current password is required." }, { status: 400 });
    }

    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: payload.currentPassword
    });
    if (signInError || signInData.user?.id !== user.id) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 401 });
    }

    const { error: updateError } = await supabase.auth.updateUser({
      current_password: payload.currentPassword,
      password: payload.newPassword
    });
    if (updateError) {
      await supabase.auth.signOut({ scope: "local" }).catch(() => null);
      return NextResponse.json(
        { error: "Unable to update password. Please try again." },
        { status: 422 }
      );
    }

    await supabase.auth.signOut({ scope: "local" }).catch(() => null);
    const { data: refreshedSignInData, error: refreshedSignInError } =
      await supabase.auth.signInWithPassword({
        email: user.email,
        password: payload.newPassword
      });
    if (refreshedSignInError || refreshedSignInData.user?.id !== user.id) {
      return withSupabaseCookies(
        NextResponse.json(
          {
            error:
              "Password updated, but your session could not be refreshed. Please sign in again."
          },
          { status: 500 }
        ),
        response
      );
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid password change request.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// null means "could not check"; the route then requires the current password.
async function checkEmailHasPassword(email: string): Promise<boolean | null> {
  try {
    return await emailHasPassword(createServiceRoleSupabaseClient(), email);
  } catch {
    return null;
  }
}

function withSupabaseCookies(response: NextResponse, authResponse: NextResponse): NextResponse {
  authResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });
  return response;
}
