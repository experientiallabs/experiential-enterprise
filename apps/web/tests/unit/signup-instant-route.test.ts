import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isSignupAllowed = vi.hoisted(() => vi.fn());
const mintApiKeySecret = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/auth/signup-gate", () => ({
  SIGNUP_DISABLED_MESSAGE: "Account creation is currently disabled.",
  isSignupAllowed
}));
vi.mock("@/lib/api-keys/keys", () => ({ mintApiKeySecret }));
// Keep the real per-IP limiter (the rate-limit test below exercises it) but
// disable the per-address email cooldown so shared test emails always send.
vi.mock("@/lib/auth/signup-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/signup-rate-limit")>()),
  allowEmailSend: () => true
}));

import { POST } from "@/app/api/signup/instant/route";

// A chainable admin stub: every filter returns `this`; the terminal call
// (maybeSingle for reads, single for the key insert) resolves to the value
// configured for the table the chain started on.
type TableResult = { data: unknown; error: unknown };
function makeAdmin(options: {
  createUser: TableResult;
  deleteUser?: () => Promise<unknown>;
  members: TableResult;
  organizations?: TableResult;
  apiKeys?: TableResult;
  generateLink?: TableResult;
}) {
  const createUser = vi.fn().mockResolvedValue(options.createUser);
  const deleteUser = vi.fn(options.deleteUser ?? (async () => ({ error: null })));
  const generateLink = vi
    .fn()
    .mockResolvedValue(
      options.generateLink ?? { data: { properties: { hashed_token: "hashed-xyz" } }, error: null }
    );
  const from = vi.fn((table: string) => {
    const result =
      table === "organization_members"
        ? options.members
        : table === "organizations"
          ? (options.organizations ?? { data: { credit_granted_usd: 20 }, error: null })
          : (options.apiKeys ?? { data: { id: "key-1" }, error: null });
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "insert"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn(async () => result);
    builder.single = vi.fn(async () => result);
    return builder;
  });
  return {
    auth: { admin: { createUser, deleteUser, generateLink } },
    from,
    __createUser: createUser,
    __deleteUser: deleteUser,
    __generateLink: generateLink
  };
}

function request(body: unknown, ip = "203.0.113.1"): NextRequest {
  return new NextRequest("http://localhost/api/signup/instant", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    method: "POST"
  });
}

describe("POST /api/signup/instant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSignupAllowed.mockResolvedValue(true);
    mintApiKeySecret.mockReturnValue({
      secret: "xpl_deadbeef",
      keyPrefix: "xpl_deadbeef",
      keySuffix: "beef",
      keyHash: "hash"
    });
    // The verification email goes out via Resend (admin generateLink + the
    // Resend HTTP API), not GoTrue SMTP.
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("creates a spend-locked (but logged-in-capable) account and returns a usable key", async () => {
    const admin = makeAdmin({
      createUser: { data: { user: { id: "user-1" } }, error: null },
      members: { data: { org_id: "org-1" }, error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(request({ email: "founder@startup.com" }, "203.0.113.10"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      api_key: "xpl_deadbeef",
      org_id: "org-1",
      credits_granted: 20,
      verification_required: true,
      verification_email_sent: true
    });
    // P1: the overview URL is the request origin, never a dev bind address.
    expect(body.overview_url).toBe("http://localhost/overview");
    expect(body.overview_url).not.toContain("0.0.0.0");
    expect(admin.__createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "founder@startup.com",
        // email_confirm:true so GoTrue permits login immediately (spend stays
        // gated on organizations.spend_unlocked_at, not on this flag).
        email_confirm: true,
        // A random bootstrap secret is required by the password-backed Auth
        // user record but the agent never uses it (it gets the xpl_ key).
        // user_metadata is undefined without an invite token.
        password: expect.any(String)
      })
    );
    expect(mintApiKeySecret).toHaveBeenCalledTimes(1);
    // P2: the verification email is dispatched via admin generateLink + Resend.
    expect(admin.__generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "founder@startup.com"
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const resendCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("api.resend.com")
    );
    expect(resendCall).toBeDefined();
  });

  it("mints a bootstrap secret within bcrypt's 72-byte cap", async () => {
    // Regression: GoTrue hashes this password with bcrypt, which caps input at
    // 72 bytes and returned 500 unexpected_failure on an 81-char secret, so
    // EVERY new-account creation failed in production. Guard the length here.
    const admin = makeAdmin({
      createUser: { data: { user: { id: "user-1" } }, error: null },
      members: { data: { org_id: "org-1" }, error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    await POST(request({ email: "founder@startup.com" }, "203.0.113.20"));

    const password = admin.__createUser.mock.calls[0]?.[0]?.password as string;
    expect(typeof password).toBe("string");
    expect(new TextEncoder().encode(password).length).toBeLessThanOrEqual(72);
    // Still high-entropy: two hyphen-stripped UUIDs is 64 hex chars.
    expect(password.length).toBeGreaterThanOrEqual(48);
  });

  it("still succeeds (key works) when the verification email fails to send", async () => {
    createServiceRoleSupabaseClient.mockReturnValue(
      makeAdmin({
        createUser: { data: { user: { id: "user-1" } }, error: null },
        members: { data: { org_id: "org-1" }, error: null },
        // generateLink fails -> verification email cannot be built/sent.
        generateLink: { data: null, error: new Error("generateLink down") }
      })
    );

    const response = await POST(request({ email: "founder@startup.com" }, "203.0.113.11"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      api_key: "xpl_deadbeef",
      verification_email_sent: false
    });
  });

  it("rejects a malformed email without consuming the rate budget", async () => {
    const response = await POST(request({ email: "not-an-email" }, "203.0.113.12"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("never mints a key for an address that already has an account", async () => {
    const admin = makeAdmin({
      createUser: {
        data: { user: null },
        error: { code: "email_exists", message: "already registered" }
      },
      members: { data: null, error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(request({ email: "taken@startup.com" }, "203.0.113.13"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "account_exists" });
    expect(mintApiKeySecret).not.toHaveBeenCalled();
  });

  it("refuses when the signup gate is closed, before creating a user", async () => {
    isSignupAllowed.mockResolvedValue(false);
    const admin = makeAdmin({
      createUser: { data: { user: { id: "user-1" } }, error: null },
      members: { data: { org_id: "org-1" }, error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(request({ email: "founder@startup.com" }, "203.0.113.14"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "signup_disabled" });
    expect(admin.__createUser).not.toHaveBeenCalled();
  });

  it("fails closed when the signup gate cannot be read", async () => {
    isSignupAllowed.mockRejectedValue(new Error("service key missing"));
    createServiceRoleSupabaseClient.mockReturnValue(
      makeAdmin({
        createUser: { data: { user: { id: "user-1" } }, error: null },
        members: { data: { org_id: "org-1" }, error: null }
      })
    );

    const response = await POST(request({ email: "founder@startup.com" }, "203.0.113.15"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "signup_disabled" });
  });

  it("removes the orphan user when provisioning did not run", async () => {
    const admin = makeAdmin({
      createUser: { data: { user: { id: "user-1" } }, error: null },
      members: { data: null, error: null }
    });
    createServiceRoleSupabaseClient.mockReturnValue(admin);

    const response = await POST(request({ email: "founder@startup.com" }, "203.0.113.16"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "signup_failed" });
    expect(admin.__deleteUser).toHaveBeenCalledWith("user-1");
    expect(mintApiKeySecret).not.toHaveBeenCalled();
  });

  it("rate-limits repeated signups from one address", async () => {
    createServiceRoleSupabaseClient.mockReturnValue(
      makeAdmin({
        createUser: { data: { user: { id: "user-1" } }, error: null },
        members: { data: { org_id: "org-1" }, error: null }
      })
    );

    const ip = "203.0.113.99";
    for (let i = 0; i < 5; i += 1) {
      const ok = await POST(request({ email: `f${i}@startup.com` }, ip));
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(request({ email: "f5@startup.com" }, ip));
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({ code: "rate_limited" });
  });
});
