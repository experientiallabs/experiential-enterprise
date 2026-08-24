import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest, NextResponse } from "next/server";

const createRouteSupabaseClient = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({
  createRouteSupabaseClient
}));
vi.mock("@/lib/auth/admin", () => ({
  createServiceRoleSupabaseClient
}));

import { POST } from "@/app/auth/password/route";

const VALID_PAYLOAD = {
  currentPassword: "current-secret",
  newPassword: "new-secret",
  confirmPassword: "new-secret"
};

function request(body: unknown) {
  return new Request("http://localhost/auth/password", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }) as NextRequest;
}

describe("POST /auth/password", () => {
  let authResponse: NextResponse | null = null;
  const auth = {
    getClaims: vi.fn(),
    getUser: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    updateUser: vi.fn()
  };
  const adminRpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    authResponse = null;
    createRouteSupabaseClient.mockImplementation((_request: NextRequest, response: NextResponse) => {
      authResponse = response;
      return { auth };
    });
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          email: "admin@experientiallabs.ai",
          amr: [{ method: "password", timestamp: 1 }]
        }
      },
      error: null
    });
    auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          app_metadata: { provider: "email", providers: ["email"] },
          identities: [{ provider: "email" }]
        }
      },
      error: null
    });
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null
    });
    auth.signOut.mockResolvedValue({ error: null });
    auth.updateUser.mockResolvedValue({ error: null });
    // Default: the account HAS a password, so every existing test stays on
    // the prove-the-current-password path.
    createServiceRoleSupabaseClient.mockReturnValue({ rpc: adminRpc });
    adminRpc.mockResolvedValue({ data: true, error: null });
  });

  it("sets the FIRST password for a passwordless email-code session, no current proof", async () => {
    // An email-code login: email identity exists, amr carries otp, and the
    // service-role lookup says no password credential is stored.
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          email: "admin@experientiallabs.ai",
          amr: [{ method: "otp", timestamp: 1 }]
        }
      },
      error: null
    });
    adminRpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(
      request({ currentPassword: null, newPassword: "new-secret", confirmPassword: "new-secret" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(adminRpc).toHaveBeenCalledWith("email_has_password", {
      check_email: "admin@experientiallabs.ai"
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "new-secret" });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("refuses a null current password when the account has one", async () => {
    // Passwordful account reached over a password session (default mocks):
    // omitting the current password must never bypass the proof.
    const response = await POST(
      request({ newPassword: "new-secret", confirmPassword: "new-secret" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Current password is required." });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("keeps OAuth-only accounts refused, not silently granted a password login", async () => {
    auth.getClaims.mockResolvedValue({
      data: {
        claims: { sub: "user-1", email: "admin@experientiallabs.ai", amr: ["oauth"] }
      },
      error: null
    });
    auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          app_metadata: { provider: "google", providers: ["google"] },
          identities: [{ provider: "google" }]
        }
      },
      error: null
    });
    adminRpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(
      request({ currentPassword: null, newPassword: "new-secret", confirmPassword: "new-secret" })
    );

    expect(response.status).toBe(422);
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password after the current password is verified", async () => {
    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(auth.signInWithPassword).toHaveBeenNthCalledWith(1, {
      email: "admin@experientiallabs.ai",
      password: "current-secret"
    });
    expect(auth.signInWithPassword).toHaveBeenNthCalledWith(2, {
      email: "admin@experientiallabs.ai",
      password: "new-secret"
    });
    expect(auth.updateUser).toHaveBeenCalledWith({
      current_password: "current-secret",
      password: "new-secret"
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("signs out the re-authenticated session when the password update fails", async () => {
    auth.updateUser.mockResolvedValue({ error: new Error("update failed") });

    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to update password. Please try again."
    });
    expect(auth.updateUser).toHaveBeenCalledWith({
      current_password: "current-secret",
      password: "new-secret"
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it("reports a refresh failure when the password changed but the new session cannot be created", async () => {
    auth.signInWithPassword
      .mockResolvedValueOnce({
        data: { user: { id: "user-1" } },
        error: null
      })
      .mockResolvedValueOnce({
        data: { user: null },
        error: new Error("refresh failed")
      });
    auth.signOut.mockImplementation(async () => {
      authResponse?.cookies.set("sb-local-auth-token", "", { maxAge: 0, path: "/" });
      return { error: null };
    });

    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Password updated, but your session could not be refreshed. Please sign in again."
    });
    expect(auth.updateUser).toHaveBeenCalledWith({
      current_password: "current-secret",
      password: "new-secret"
    });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.cookies.get("sb-local-auth-token")?.value).toBe("");
  });

  it("does not update the password when the current password is wrong", async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: new Error("invalid credentials")
    });

    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(401);
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("rejects accounts without an email claim", async () => {
    auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-1" } },
      error: null
    });

    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "This account does not have an email/password sign-in to change."
    });
    expect(auth.getUser).not.toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejects email identities from sessions that were not authenticated by password", async () => {
    auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          email: "admin@experientiallabs.ai",
          amr: [{ method: "otp", timestamp: 1 }]
        }
      },
      error: null
    });

    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "This account does not have an email/password sign-in to change."
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("rejects accounts without a password identity", async () => {
    auth.getUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          app_metadata: { provider: "google", providers: ["google"] },
          identities: [{ provider: "google" }]
        }
      },
      error: null
    });

    const response = await POST(request(VALID_PAYLOAD));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "This account does not have an email/password sign-in to change."
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
