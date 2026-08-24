import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType, User } from "@supabase/supabase-js";

import {
  createServiceRoleSupabaseClient,
  deleteUnprovisionedUser
} from "@/lib/auth/admin";
import {
  createPasswordRecoveryTicket,
  passwordRecoveryCookieOptions,
  PASSWORD_RECOVERY_COOKIE,
  sessionIdFromAccessToken
} from "@/lib/auth/password-recovery";
import { requestOrigin, safeNextPath } from "@/lib/auth/redirects";
import { createRouteSupabaseClient } from "@/lib/auth/server";
import { signinMethodsForEmail } from "@/lib/auth/signin-methods";
import { unlockSpendOnInboxProof } from "@/lib/auth/spend-unlock";
import { signinPath } from "@/lib/routes";

// A user this recently created is a first-time sign-in, not a returning
// account: automatic identity linking merges a provider into the EXISTING
// same-email user (whose created_at is old), so a fresh user means linking did
// not happen. Wider than any real OAuth round-trip to absorb clock skew.
const FRESH_SIGNUP_WINDOW_MS = 10 * 60 * 1000;

// Completes both browser-bound auth flows: OAuth PKCE redirects carry ?code=,
// GoTrue email links (invites) carry ?token_hash=&type=. Either way a session
// is established on the redirect response, then gated on provisioning. A failed
// provider dance instead lands here with ?error= and no ?code=.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get("next"));
  const response = NextResponse.redirect(new URL(next, requestOrigin(request)), { status: 303 });
  const supabase = createRouteSupabaseClient(request, response);

  // GoTrue bounces a failed provider dance back here as ?error= with no ?code=.
  // The one failure worth naming is a REFUSED identity link: when the provider
  // email matches an existing account but GoTrue will not safely auto-link it
  // (the existing email is unverified — a pre-account-takeover risk it declines
  // — or manual linking is required, or the email now collides), it returns an
  // email/identity-conflict error instead of a session. Surface that as the
  // actionable "account already exists" message so the user signs in with their
  // original method, rather than the generic "provider failed" dead end.
  const providerError = params.get("error");
  if (providerError !== null) {
    const code = classifyProviderError(
      providerError,
      params.get("error_code"),
      params.get("error_description")
    );
    return redirectToLoginError(response, request, code);
  }

  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const otpType = params.get("type") as EmailOtpType | null;

  let userId: string | null = null;
  let userCreatedAt: string | null = null;
  let recoverySessionId: string | null = null;
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return redirectToLoginError(response, request, "oauth_failed");
    }
    userId = data.user?.id ?? null;
    userCreatedAt = data.user?.created_at ?? null;

    // Linking safety net. The happy path is invisible here: automatic linking
    // attaches the provider identity to the existing same-email account and
    // exchangeCodeForSession returns THAT (old) user, so no fresh user results
    // and this classifies as "safe". But if the sign-in instead produced a
    // brand-new user whose email is already owned by a DIFFERENT account's
    // identity, GoTrue did not (could not safely) link them — handing out this
    // session would strand the user on a duplicate account. This is a
    // session-integrity decision, so it fails CLOSED: when the check cannot
    // confirm safety, refuse the session rather than let a possible duplicate
    // stand (unlike the signin route, whose same lookup fails open because it
    // only picks which message to disclose, never whether to seat a session).
    switch (await classifyOAuthUser(data.user)) {
      case "duplicate":
        // A different account owns this email; clean up the removable orphan
        // and route the user to their existing sign-in method.
        await supabase.auth.signOut();
        if (userId !== null) {
          await deleteUnprovisionedUser(userId);
        }
        return redirectToLoginError(response, request, "account_exists");
      case "unverifiable":
        // Fresh user but the collision lookup could not run. Do not seat the
        // session on an unverified account and do not delete it (it may be a
        // legitimate first-time signup); a retry once the lookup recovers
        // resolves to "safe" or "duplicate".
        await supabase.auth.signOut();
        return redirectToLoginError(response, request, "oauth_failed");
      case "safe":
        break;
    }
  } else if (tokenHash && otpType) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType });
    if (error) {
      return redirectToLoginError(response, request, "invite_invalid");
    }
    userId = data.user?.id ?? null;
    userCreatedAt = data.user?.created_at ?? null;
    if (otpType === "recovery") {
      recoverySessionId = sessionIdFromAccessToken(data.session?.access_token);
      if (recoverySessionId === null) {
        await supabase.auth.signOut();
        return redirectToLoginError(response, request, "invite_invalid");
      }
    }
  }
  if (!userId) {
    return redirectToLoginError(response, request, "oauth_failed");
  }

  // Account-creation gate: a first sign-in that arrives with no org
  // membership is an uninvited signup made while signups are disabled (the
  // provisioning trigger declined the personal-org fallback). Reject the
  // session and clean up the orphaned auth user so a later invite can
  // re-create it. RLS scopes this query to the user's own memberships.
  const { count, error: membershipError } = await supabase
    .from("organization_members")
    .select("org_id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (membershipError !== null) {
    // Fail closed like the signup route: if provisioning cannot be verified,
    // no session is handed out. The user is not deleted here — the check may
    // have failed transiently, and retrying sign-in is cheap.
    await supabase.auth.signOut();
    return redirectToLoginError(response, request, "oauth_failed");
  }
  if ((count ?? 0) === 0) {
    // Only a just-created account is an uninvited signup the trigger
    // declined. A long-standing account with zero memberships is a real user
    // whose last membership an admin removed — deleting it here would destroy
    // their identity on their next OAuth sign-in. Let them through to the
    // (empty) organizations page like password logins do.
    const isFreshSignup =
      userCreatedAt !== null &&
      Date.now() - new Date(userCreatedAt).getTime() < FRESH_SIGNUP_WINDOW_MS;
    if (isFreshSignup) {
      await supabase.auth.signOut();
      await deleteUnprovisionedUser(userId);
      return redirectToLoginError(response, request, "signup_disabled");
    }
  }

  // Inbox ownership is proven here: the verification magic link (type=magiclink)
  // and OAuth/invite links all reach this success path only after the user
  // controls the address/provider. Unlock credit spending for their org(s) — the
  // decoupled signal the P1025 gate reads — which also fires credential rotation,
  // evicting any pre-unlock key/session an attacker held for this address.
  // Best-effort: never fail an otherwise-good sign-in on an unlock hiccup.
  // Routes on app_settings.spend_unlock_requirement: inbox proof unlocks in the
  // default 'email' mode; in 'card' mode a saved card is required instead.
  await unlockSpendOnInboxProof(createServiceRoleSupabaseClient(), userId);

  if (recoverySessionId !== null) {
    response.cookies.set(
      PASSWORD_RECOVERY_COOKIE,
      createPasswordRecoveryTicket({ userId, sessionId: recoverySessionId }),
      passwordRecoveryCookieOptions()
    );
  }

  return response;
}

type OAuthUserClassification = "safe" | "duplicate" | "unverifiable";

// Classifies the user an OAuth exchange returned:
//   "safe"         linking succeeded / a genuine first-time signup — the
//                  returned user is the existing (non-fresh) account, or a
//                  fresh user whose email carries no foreign identity.
//   "duplicate"    a fresh user whose email is already owned by a DIFFERENT
//                  account's identity — automatic linking did not merge them.
//   "unverifiable" a fresh user for which the collision lookup could not run
//                  (missing service key, GoTrue hiccup); the caller must fail
//                  closed rather than seat a session on an unverified account.
async function classifyOAuthUser(
  user: User | null | undefined
): Promise<OAuthUserClassification> {
  const email = user?.email ?? null;
  const createdAt = user?.created_at ?? null;
  if (email === null || createdAt === null) {
    return "safe";
  }
  const isFresh = Date.now() - new Date(createdAt).getTime() < FRESH_SIGNUP_WINDOW_MS;
  if (!isFresh) {
    // A returning or freshly-linked account; the provider is on this same user.
    return "safe";
  }
  const ownProviders = new Set(
    (user?.identities ?? [])
      .map((identity) => identity.provider)
      .filter((provider): provider is string => typeof provider === "string")
  );
  let methods: string[] | null;
  try {
    methods = await signinMethodsForEmail(createServiceRoleSupabaseClient(), email);
  } catch {
    methods = null;
  }
  if (methods === null) {
    return "unverifiable";
  }
  // A provider registered for this email that is NOT on the fresh user belongs
  // to a pre-existing, separate account: the duplicate this guard refuses.
  return methods.some((method) => !ownProviders.has(method)) ? "duplicate" : "safe";
}

// GoTrue's ?error= redirect covers everything from a user-cancelled consent to
// a refused identity link. Only the identity/email conflict earns the specific
// "account already exists" message; every other provider error stays generic.
// The signals are matched broadly on purpose — GoTrue's exact code for a
// refused link varies by version and configuration, and the cost of a miss is
// only the less-specific (still safe) message.
function classifyProviderError(
  error: string,
  errorCode: string | null,
  errorDescription: string | null
): "account_exists" | "oauth_failed" {
  const conflictCodes = new Set([
    "email_exists",
    "user_already_exists",
    "identity_already_exists",
    "manual_linking_disabled"
  ]);
  if (errorCode !== null && conflictCodes.has(errorCode)) {
    return "account_exists";
  }
  const haystack = `${error} ${errorDescription ?? ""}`.toLowerCase();
  if (
    haystack.includes("already registered") ||
    haystack.includes("already exists") ||
    haystack.includes("already been registered") ||
    haystack.includes("identity is already linked")
  ) {
    return "account_exists";
  }
  return "oauth_failed";
}

// Reuse the response object so cookie writes made through the Supabase
// adapter (session, sign-out clears) survive onto the error redirect.
function redirectToLoginError(
  response: NextResponse,
  request: NextRequest,
  code: string
): NextResponse {
  const url = new URL(signinPath(), requestOrigin(request));
  url.searchParams.set("error", code);
  response.headers.set("location", url.toString());
  return response;
}
