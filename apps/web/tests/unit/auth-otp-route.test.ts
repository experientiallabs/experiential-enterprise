import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest, NextResponse } from "next/server";

const createRouteSupabaseClient = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isSignupAllowed = vi.hoisted(() => vi.fn());
const unlockSpendOnInboxProof = vi.hoisted(() => vi.fn());
const allowEmailSend = vi.hoisted(() => vi.fn());
const releaseEmailSend = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  createRouteSupabaseClient
}));
vi.mock("@/lib/auth/admin", () => ({
  createServiceRoleSupabaseClient
}));
vi.mock("@/lib/auth/signup-gate", () => ({
  isSignupAllowed
}));
vi.mock("@/lib/auth/signup-rate-limit", () => ({ allowEmailSend, releaseEmailSend }));
vi.mock("@/lib/auth/spend-unlock", () => ({ unlockSpendOnInboxProof }));

import { POST as requestCode } from "@/app/auth/otp/route";
import { POST as verifyCode } from "@/app/auth/otp/verify/route";

function request(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      host: "localhost",
      "x-forwarded-proto": "http"
    },
    method: "POST"
  }) as NextRequest;
}

describe("POST /auth/otp", () => {
  const auth = { signInWithOtp: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    createRouteSupabaseClient.mockReturnValue({ auth });
    createServiceRoleSupabaseClient.mockReturnValue({});
    auth.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    isSignupAllowed.mockResolvedValue(true);
    allowEmailSend.mockReturnValue(true);
  });

  it("sends a code, allowing account creation when the gate allows", async () => {
    const response = await requestCode(
      request("/auth/otp", { email: "user@example.com", inviteToken: "tok-1" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: "http://localhost/auth/callback",
        data: { invite_token: "tok-1" }
      }
    });
  });

  it("answers the gate-blocked case with the exact same neutral 200", async () => {
    isSignupAllowed.mockResolvedValue(false);
    // GoTrue's no-account-and-no-signups rejection must not leak outward.
    auth.signInWithOtp.mockResolvedValue({
      data: {},
      error: { code: "otp_disabled", message: "Signups not allowed for otp", status: 422 }
    });

    const response = await requestCode(request("/auth/otp", { email: "gated@example.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "gated@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "http://localhost/auth/callback" }
    });
  });

  it("fails closed to shouldCreateUser=false when the gate is unreadable", async () => {
    isSignupAllowed.mockRejectedValue(new Error("db down"));

    await requestCode(request("/auth/otp", { email: "user@example.com" }));

    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      options: { shouldCreateUser: false, emailRedirectTo: "http://localhost/auth/callback" }
    });
  });

  it("surfaces GoTrue's send-frequency cap as 429", async () => {
    auth.signInWithOtp.mockResolvedValue({
      data: {},
      error: { code: "over_email_send_rate_limit", message: "too many", status: 429 }
    });

    const response = await requestCode(request("/auth/otp", { email: "user@example.com" }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "rate_limited" });
    expect(releaseEmailSend).toHaveBeenCalledWith("user@example.com");
  });

  it("releases the cooldown when GoTrue rejects the send", async () => {
    auth.signInWithOtp.mockResolvedValue({
      data: {},
      error: { code: "mailer_failed", message: "temporary failure", status: 500 }
    });

    const response = await requestCode(request("/auth/otp", { email: "user@example.com" }));

    expect(response.status).toBe(502);
    expect(releaseEmailSend).toHaveBeenCalledWith("user@example.com");
  });

  it("releases the cooldown when GoTrue throws during the send", async () => {
    auth.signInWithOtp.mockRejectedValue(new Error("network down"));

    const response = await requestCode(request("/auth/otp", { email: "user@example.com" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "otp_send_failed" });
    expect(releaseEmailSend).toHaveBeenCalledWith("user@example.com");
  });

  it("enforces the per-address cooldown before touching GoTrue", async () => {
    allowEmailSend.mockReturnValue(false);

    const response = await requestCode(request("/auth/otp", { email: "user@example.com" }));

    expect(response.status).toBe(429);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("rejects a malformed email before touching GoTrue", async () => {
    const response = await requestCode(request("/auth/otp", { email: "not-an-email" }));

    expect(response.status).toBe(400);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });
});

describe("POST /auth/otp/verify", () => {
  const auth = { verifyOtp: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    createRouteSupabaseClient.mockReturnValue({ auth });
    createServiceRoleSupabaseClient.mockReturnValue({});
    unlockSpendOnInboxProof.mockResolvedValue(undefined);
  });

  it("verifies the code and reports an established account", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { user: { id: "user-1", created_at: "2026-01-01T00:00:00Z" } },
      error: null
    });

    const response = await verifyCode(
      request("/auth/otp/verify", { email: "user@example.com", token: "123456" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, created: false });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: "user@example.com",
      token: "123456",
      type: "email"
    });
    // Entering the emailed code proves inbox ownership -> unlock spend.
    expect(unlockSpendOnInboxProof).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("reports created for an account this code request made", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { user: { id: "user-1", created_at: new Date().toISOString() } },
      error: null
    });

    const response = await verifyCode(
      request("/auth/otp/verify", { email: "user@example.com", token: "123456" })
    );

    await expect(response.json()).resolves.toEqual({ ok: true, created: true });
  });

  it("answers 400 otp_invalid for a wrong or expired code", async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { user: null },
      error: { code: "otp_expired", message: "expired", status: 403 }
    });

    const response = await verifyCode(
      request("/auth/otp/verify", { email: "user@example.com", token: "123456" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "otp_invalid" });
    // A rejected code proves nothing, so spend must not unlock.
    expect(unlockSpendOnInboxProof).not.toHaveBeenCalled();
  });

  it("rejects a non-6-digit token shape without calling GoTrue", async () => {
    const response = await verifyCode(
      request("/auth/otp/verify", { email: "user@example.com", token: "abc" })
    );

    expect(response.status).toBe(400);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});
