import { NextResponse, type NextRequest } from "next/server";

import { safePrefillEmail } from "@/lib/auth/redirects";
import { carryAuthCookies, createRouteSupabaseClient } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Password sign-in — the OPTIONAL alternative to the passwordless default. Auth
// stays passwordless-first (OAuth + emailed 6-digit code); a user only reaches
// here if they set a real password through the reset/set-password flow
// (/auth/password/reset). Signup never sets a user-known password, so a fresh
// account has none until it opts in.
//
//   200 { ok, created:false }        signed in; the session cookies ride back
//   401 { code:"invalid_credentials" } wrong email/password OR no password set
//   400 { code:"invalid_request" }   malformed email/body
//
// The 401 is deliberately uniform: it never distinguishes "no such account",
// "no password set on this account", and "wrong password", so password sign-in
// leaks no account/credential-existence oracle (the emailed-code path is the
// account-existence-neutral entry, same as today).
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

  const { data, error } = await supabase.auth.signInWithPassword({
    email: payload.email,
    password: payload.password
  });
  if (error !== null || data.user === null) {
    return NextResponse.json(
      { code: "invalid_credentials", error: "Invalid email or password." },
      { status: 401 }
    );
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
