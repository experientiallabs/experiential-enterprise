import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const sendPasswordResetEmail = vi.hoisted(() => vi.fn());
const allowEmailSend = vi.hoisted(() => vi.fn());
const createRouteSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/auth/verification", () => ({ sendPasswordResetEmail }));
vi.mock("@/lib/auth/signup-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/signup-rate-limit")>()),
  allowEmailSend
}));
vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  createRouteSupabaseClient
}));

import { POST as requestReset } from "@/app/auth/password/reset/route";
import { POST as confirmReset } from "@/app/auth/password/reset/confirm/route";
import {
  createPasswordRecoveryTicket,
  PASSWORD_RECOVERY_COOKIE
} from "@/lib/auth/password-recovery";

function request(path: string, body: unknown, recoveryTicket?: string) {
  const result = new NextRequest(`http://localhost${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (recoveryTicket !== undefined) {
    result.cookies.set(PASSWORD_RECOVERY_COOKIE, recoveryTicket);
  }
  return result;
}

function recoveryRequest(body: unknown, sessionId = "recovery-session") {
  return request(
    "/auth/password/reset/confirm",
    body,
    createPasswordRecoveryTicket({ userId: "user-1", sessionId })
  );
}

describe("POST /auth/password/reset (request)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowEmailSend.mockReturnValue(true);
    createServiceRoleSupabaseClient.mockReturnValue({});
    sendPasswordResetEmail.mockResolvedValue({ sent: true });
  });

  it("emails a recovery link via the Resend path", async () => {
    const response = await requestReset(request("/auth/password/reset", { email: "a@b.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.anything(),
      "a@b.com",
      expect.stringContaining("http")
    );
  });

  it("stays neutral (200) even when the mailer fails — no existence oracle", async () => {
    sendPasswordResetEmail.mockResolvedValue({ sent: false, reason: "no such user" });

    const response = await requestReset(request("/auth/password/reset", { email: "a@b.com" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not send while the per-address cooldown is active, but still answers 200", async () => {
    allowEmailSend.mockReturnValue(false);

    const response = await requestReset(request("/auth/password/reset", { email: "a@b.com" }));

    expect(response.status).toBe(200);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("rejects a malformed email", async () => {
    const response = await requestReset(request("/auth/password/reset", { email: "nope" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("POST /auth/password/reset/confirm (set password)", () => {
  const auth = { getClaims: vi.fn(), updateUser: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    createRouteSupabaseClient.mockImplementation((_req: NextRequest, _res: NextResponse) => ({
      auth
    }));
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          session_id: "recovery-session",
          amr: [{ method: "otp", timestamp: 1 }]
        }
      },
      error: null
    });
    auth.updateUser.mockResolvedValue({ error: null });
  });

  it("sets the password on a recovery session", async () => {
    const response = await confirmReset(recoveryRequest({ password: "brand-new-pw" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "brand-new-pw" });
    expect(response.cookies.get(PASSWORD_RECOVERY_COOKIE)?.value).toBe("");
  });

  it("accepts the bare-string recovery amr form with the callback ticket", async () => {
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          session_id: "recovery-session",
          amr: ["recovery"]
        }
      },
      error: null
    });

    const response = await confirmReset(recoveryRequest({ password: "brand-new-pw" }));

    expect(response.status).toBe(200);
    expect(auth.updateUser).toHaveBeenCalled();
  });

  it("refuses an ordinary OTP session without the recovery callback ticket", async () => {
    const response = await confirmReset(
      request("/auth/password/reset/confirm", { password: "brand-new-pw" })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "no_recovery" });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a recovery ticket minted for a different Supabase session", async () => {
    const response = await confirmReset(
      recoveryRequest({ password: "brand-new-pw" }, "different-session")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "no_recovery" });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("refuses a non-email-link session even with a matching ticket", async () => {
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          session_id: "recovery-session",
          amr: [{ method: "password", timestamp: 1 }]
        }
      },
      error: null
    });

    const response = await confirmReset(recoveryRequest({ password: "brand-new-pw" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "no_recovery" });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejects a weak password before touching the session", async () => {
    const response = await confirmReset(
      request("/auth/password/reset/confirm", { password: "123" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "weak_password" });
    expect(auth.getClaims).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("returns 422 when GoTrue refuses the update", async () => {
    auth.updateUser.mockResolvedValue({ error: { message: "same as old" } });

    const response = await confirmReset(recoveryRequest({ password: "brand-new-pw" }));

    expect(response.status).toBe(422);
  });
});
