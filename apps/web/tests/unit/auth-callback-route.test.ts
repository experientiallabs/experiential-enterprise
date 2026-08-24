import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  exchangeCodeForSession,
  verifyOtp,
  signOut,
  deleteUnprovisionedUser,
  signinMethodsForEmail,
  unlockSpendOnInboxProof,
  membership
} = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  deleteUnprovisionedUser: vi.fn(),
  signinMethodsForEmail: vi.fn(),
  unlockSpendOnInboxProof: vi.fn(),
  membership: { count: 1 as number | null, error: null as unknown }
}));

vi.mock("@/lib/auth/server", () => ({
  createRouteSupabaseClient: () => ({
    auth: { exchangeCodeForSession, verifyOtp, signOut },
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ count: membership.count, error: membership.error })
      })
    })
  })
}));

vi.mock("@/lib/auth/admin", () => ({
  createServiceRoleSupabaseClient: () => ({}),
  deleteUnprovisionedUser
}));

vi.mock("@/lib/auth/signin-methods", () => ({ signinMethodsForEmail }));

vi.mock("@/lib/auth/spend-unlock", () => ({ unlockSpendOnInboxProof }));

import { GET } from "@/app/auth/callback/route";
import {
  PASSWORD_RECOVERY_COOKIE,
  verifyPasswordRecoveryTicket
} from "@/lib/auth/password-recovery";

const HOST = "https://app.example.test";

function callbackRequest(query: string): NextRequest {
  return new NextRequest(`http://0.0.0.0:3000/auth/callback?${query}`, {
    headers: {
      host: "0.0.0.0:3000",
      "x-forwarded-host": "app.example.test",
      "x-forwarded-proto": "https"
    }
  });
}

function accessToken(userId: string, sessionId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, session_id: sessionId })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function freshUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-new",
    email: "sam@company.com",
    created_at: new Date().toISOString(),
    identities: [{ provider: "google" }],
    ...overrides
  };
}

function existingUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-old",
    email: "sam@company.com",
    // Well outside the fresh-signup window: a returning / freshly-linked account.
    created_at: "2020-01-01T00:00:00.000Z",
    identities: [{ provider: "email" }, { provider: "google" }],
    ...overrides
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  membership.count = 1;
  membership.error = null;
  exchangeCodeForSession.mockResolvedValue({ data: { user: existingUser() }, error: null });
  verifyOtp.mockResolvedValue({
    data: {
      user: existingUser(),
      session: { access_token: accessToken("user-old", "recovery-session") }
    },
    error: null
  });
  signOut.mockResolvedValue(undefined);
  deleteUnprovisionedUser.mockResolvedValue(undefined);
  signinMethodsForEmail.mockResolvedValue(["email", "google"]);
  unlockSpendOnInboxProof.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/auth/callback", () => {
  it("links a provider into the matching account: an existing user signs in cleanly", async () => {
    // Automatic linking merged Google into the existing same-email account, so
    // the exchange returns that (old) user with both identities. The callback
    // must hand out the session, not treat it as a duplicate.
    const response = await GET(callbackRequest("code=abc&next=%2Fmodels"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${HOST}/models`);
    expect(signOut).not.toHaveBeenCalled();
    expect(deleteUnprovisionedUser).not.toHaveBeenCalled();
    // Inbox ownership is proven on this success path, so credit spending is
    // unlocked for the signed-in user (which also rotates pre-unlock creds).
    expect(unlockSpendOnInboxProof).toHaveBeenCalledWith(expect.anything(), "user-old");
  });

  it("refuses an unsafe duplicate: a fresh user whose email another account owns", async () => {
    // The email already carries an "email" identity on a different account, so
    // linking did not merge them. No duplicate session is handed out.
    exchangeCodeForSession.mockResolvedValue({ data: { user: freshUser() }, error: null });
    signinMethodsForEmail.mockResolvedValue(["email", "google"]);

    const response = await GET(callbackRequest("code=abc&next=%2Fmodels"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=account_exists`);
    expect(signOut).toHaveBeenCalledOnce();
    expect(deleteUnprovisionedUser).toHaveBeenCalledWith("user-new");
    // A refused session must not unlock spend for the (possible-victim) address.
    expect(unlockSpendOnInboxProof).not.toHaveBeenCalled();
  });

  it("allows a genuine first-time provider signup (no foreign identity)", async () => {
    // Fresh user, and the only method registered for the email is the provider
    // just used — a real new signup, not a collision.
    exchangeCodeForSession.mockResolvedValue({ data: { user: freshUser() }, error: null });
    signinMethodsForEmail.mockResolvedValue(["google"]);

    const response = await GET(callbackRequest("code=abc&next=%2F"));

    expect(response.headers.get("location")).toBe(`${HOST}/`);
    expect(signOut).not.toHaveBeenCalled();
    expect(deleteUnprovisionedUser).not.toHaveBeenCalled();
  });

  it("fails closed when the collision lookup cannot run for a fresh user", async () => {
    // Fresh user but the service-role lookup failed (null). Session integrity
    // must not depend on that lookup: refuse the (possible-duplicate) session
    // rather than seat it, but do not delete a maybe-legitimate new signup.
    exchangeCodeForSession.mockResolvedValue({ data: { user: freshUser() }, error: null });
    signinMethodsForEmail.mockResolvedValue(null);

    const response = await GET(callbackRequest("code=abc&next=%2F"));

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=oauth_failed`);
    expect(signOut).toHaveBeenCalledOnce();
    expect(deleteUnprovisionedUser).not.toHaveBeenCalled();
  });

  it("names a refused identity link from GoTrue's error redirect", async () => {
    const response = await GET(
      callbackRequest("error=server_error&error_code=email_exists&error_description=nope")
    );

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=account_exists`);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("names a conflict from the error_description when no code is present", async () => {
    const response = await GET(
      callbackRequest(
        "error=server_error&error_description=A%20user%20with%20this%20email%20already%20exists"
      )
    );

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=account_exists`);
  });

  it("keeps other provider errors generic", async () => {
    const response = await GET(
      callbackRequest("error=access_denied&error_description=user%20cancelled")
    );

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=oauth_failed`);
  });

  it("rejects a fresh OAuth signup while signups are disabled", async () => {
    // Fresh, no foreign identity (passes the duplicate guard), but the trigger
    // declined provisioning: zero memberships -> orphan cleanup + signup_disabled.
    exchangeCodeForSession.mockResolvedValue({ data: { user: freshUser() }, error: null });
    signinMethodsForEmail.mockResolvedValue(["google"]);
    membership.count = 0;

    const response = await GET(callbackRequest("code=abc&next=%2F"));

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=signup_disabled`);
    expect(signOut).toHaveBeenCalledOnce();
    expect(deleteUnprovisionedUser).toHaveBeenCalledWith("user-new");
  });

  it("reports oauth_failed when the code exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });

    const response = await GET(callbackRequest("code=abc&next=%2F"));

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=oauth_failed`);
  });

  it("binds a recovery callback ticket to the verified Supabase session", async () => {
    const response = await GET(
      callbackRequest("token_hash=hashed&type=recovery&next=%2Freset-password")
    );

    expect(response.headers.get("location")).toBe(`${HOST}/reset-password`);
    const ticket = response.cookies.get(PASSWORD_RECOVERY_COOKIE);
    expect(ticket?.httpOnly).toBe(true);
    expect(ticket?.sameSite).toBe("lax");
    expect(
      verifyPasswordRecoveryTicket(ticket?.value, {
        userId: "user-old",
        sessionId: "recovery-session"
      })
    ).toBe(true);
  });

  it("refuses a recovery exchange without a session-bound access token", async () => {
    verifyOtp.mockResolvedValue({
      data: { user: existingUser(), session: null },
      error: null
    });

    const response = await GET(
      callbackRequest("token_hash=hashed&type=recovery&next=%2Freset-password")
    );

    expect(response.headers.get("location")).toBe(`${HOST}/signin?error=invite_invalid`);
    expect(signOut).toHaveBeenCalledOnce();
    expect(response.cookies.get(PASSWORD_RECOVERY_COOKIE)).toBeUndefined();
  });
});
