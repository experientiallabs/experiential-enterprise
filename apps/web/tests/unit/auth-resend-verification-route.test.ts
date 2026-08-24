import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const getAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const sendVerificationEmail = vi.hoisted(() => vi.fn());
const allowEmailSend = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/server")>()),
  getAuthenticatedUser
}));
vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/auth/verification", () => ({ sendVerificationEmail }));
vi.mock("@/lib/auth/signup-rate-limit", () => ({ allowEmailSend }));

import { POST } from "@/app/auth/resend-verification/route";

function request() {
  return new Request("http://localhost/auth/resend-verification", {
    method: "POST",
    headers: { host: "localhost", "x-forwarded-proto": "http" }
  }) as NextRequest;
}

describe("POST /auth/resend-verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createServiceRoleSupabaseClient.mockReturnValue({});
    sendVerificationEmail.mockResolvedValue({ sent: true });
    allowEmailSend.mockReturnValue(true);
  });

  it("resends the verification email for the signed-in user", async () => {
    getAuthenticatedUser.mockResolvedValue({ id: "u1", email: "founder@company.com" });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.anything(),
      "founder@company.com",
      expect.stringContaining("http")
    );
  });

  it("requires authentication", async () => {
    getAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("respects the per-address cooldown without erroring", async () => {
    getAuthenticatedUser.mockResolvedValue({ id: "u1", email: "founder@company.com" });
    allowEmailSend.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});
