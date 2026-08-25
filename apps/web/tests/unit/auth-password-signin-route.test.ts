import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest, NextResponse } from "next/server";

const createRouteSupabaseClient = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn(() => ({}) as unknown));
const signinMethodsForEmail = vi.hoisted(() => vi.fn());
const allowSigninAttempt = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  createRouteSupabaseClient
}));

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));

vi.mock("@/lib/auth/signin-methods", () => ({ signinMethodsForEmail }));

vi.mock("@/lib/auth/signup-rate-limit", () => ({
  allowSigninAttempt,
  clientIp: () => "203.0.113.7"
}));

import { POST } from "@/app/auth/password/signin/route";

function request(body: unknown) {
  return new Request("http://localhost/auth/password/signin", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }) as NextRequest;
}

describe("POST /auth/password/signin", () => {
  const auth = { signInWithPassword: vi.fn() };
  const rejected = {
    data: { user: null },
    error: { message: "Invalid login credentials", status: 400 }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    allowSigninAttempt.mockReturnValue(true);
    createRouteSupabaseClient.mockImplementation((_req: NextRequest, _res: NextResponse) => ({
      auth
    }));
  });

  it("signs in with a valid email + password", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    const response = await POST(request({ email: "founder@company.com", password: "hunter2xx" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, created: false });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "founder@company.com",
      password: "hunter2xx"
    });
    expect(signinMethodsForEmail).not.toHaveBeenCalled();
  });

  it("returns 401 no_account when the email has no account", async () => {
    auth.signInWithPassword.mockResolvedValue(rejected);
    signinMethodsForEmail.mockResolvedValue([]);

    const response = await POST(request({ email: "nobody@company.com", password: "nope" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "no_account" });
    expect(signinMethodsForEmail).toHaveBeenCalledWith(expect.anything(), "nobody@company.com");
  });

  it("returns 401 wrong_password when the account exists but the password is bad", async () => {
    auth.signInWithPassword.mockResolvedValue(rejected);
    signinMethodsForEmail.mockResolvedValue(["email"]);

    const response = await POST(request({ email: "founder@company.com", password: "nope" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "wrong_password",
      error: "Wrong password."
    });
  });

  it("falls back to wrong_password when the existence lookup is inconclusive", async () => {
    // A null lookup (missing service key / GoTrue hiccup) must never manufacture
    // a no_account signal for an address that may well exist.
    auth.signInWithPassword.mockResolvedValue(rejected);
    signinMethodsForEmail.mockResolvedValue(null);

    const response = await POST(request({ email: "founder@company.com", password: "nope" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "wrong_password" });
  });

  it("returns 429 and never touches GoTrue when the attempt limit is hit", async () => {
    allowSigninAttempt.mockReturnValue(false);

    const response = await POST(request({ email: "founder@company.com", password: "hunter2xx" }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "rate_limited" });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(signinMethodsForEmail).not.toHaveBeenCalled();
  });

  it("rejects a malformed email before rate limiting or touching GoTrue", async () => {
    const response = await POST(request({ email: "not-an-email", password: "hunter2xx" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(allowSigninAttempt).not.toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("rejects a missing password", async () => {
    const response = await POST(request({ email: "founder@company.com" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});
