import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isSignupAllowed = vi.hoisted(() => vi.fn());
const sendSigninCode = vi.hoisted(() => vi.fn());
const sendSignupCode = vi.hoisted(() => vi.fn());
const allowSignupStart = vi.hoisted(() => vi.fn());
const allowEmailSend = vi.hoisted(() => vi.fn());
const releaseEmailSend = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/auth/signup-gate", () => ({
  SIGNUP_DISABLED_MESSAGE: "disabled",
  isSignupAllowed
}));
vi.mock("@/lib/auth/verification", () => ({ sendSigninCode, sendSignupCode }));
vi.mock("@/lib/auth/signup-rate-limit", () => ({
  allowSignupStart,
  allowEmailSend,
  releaseEmailSend,
  clientIp: () => "1.2.3.4"
}));

import { GET } from "@/app/signup/route";

function request(query: string) {
  return new NextRequest(`http://localhost/signup${query}`);
}

function location(response: Response): string {
  return response.headers.get("location") ?? "";
}

describe("GET /signup", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    allowSignupStart.mockReturnValue(true);
    createServiceRoleSupabaseClient.mockReturnValue({ rpc });
    // No existing account by default.
    rpc.mockResolvedValue({ data: [], error: null });
    isSignupAllowed.mockResolvedValue(true);
    sendSigninCode.mockResolvedValue(true);
    sendSignupCode.mockResolvedValue(true);
    allowEmailSend.mockReturnValue(true);
  });

  it("falls back to /signin when no email is present", async () => {
    const response = await GET(request(""));
    expect(response.status).toBe(303);
    expect(location(response)).toBe("http://localhost/signin");
  });

  it("starts a new account in the six-digit code flow", async () => {
    const response = await GET(request("?email=founder%40startup.com"));

    expect(response.status).toBe(303);
    expect(location(response)).toBe(
      "http://localhost/signin?email=founder%40startup.com&sent=1&signup=1"
    );
    expect(sendSignupCode).toHaveBeenCalledWith("founder@startup.com", "http://localhost");
    expect(sendSigninCode).not.toHaveBeenCalled();
  });

  it("does not claim a code was sent when the new-account send fails", async () => {
    sendSignupCode.mockResolvedValue(false);

    const response = await GET(request("?email=founder%40startup.com"));

    expect(location(response)).toBe(
      "http://localhost/signin?email=founder%40startup.com&error=otp_send_failed&signup=1"
    );
    expect(releaseEmailSend).toHaveBeenCalledWith("founder@startup.com");
  });

  it("does not claim a code was sent during the email cooldown", async () => {
    allowEmailSend.mockReturnValue(false);

    const response = await GET(request("?email=founder%40startup.com"));

    expect(location(response)).toBe(
      "http://localhost/signin?email=founder%40startup.com&error=rate_limited&signup=1"
    );
    expect(sendSignupCode).not.toHaveBeenCalled();
  });

  it("never auto-logs-in an existing account: emails a code and bounces to sign-in", async () => {
    rpc.mockResolvedValue({ data: ["email"], error: null });

    const response = await GET(request("?email=member%40startup.com"));

    expect(response.status).toBe(303);
    expect(location(response)).toBe("http://localhost/signin?email=member%40startup.com&sent=1");
    expect(sendSigninCode).toHaveBeenCalledWith("member@startup.com", "http://localhost");
  });

  it("releases the email cooldown when an existing-account send fails", async () => {
    rpc.mockResolvedValue({ data: ["email"], error: null });
    sendSigninCode.mockResolvedValue(false);

    const response = await GET(request("?email=member%40startup.com"));

    expect(location(response)).toContain("error=otp_send_failed");
    expect(releaseEmailSend).toHaveBeenCalledWith("member@startup.com");
  });

  it("treats an unknown lookup as sign-in, never creating a duplicate", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("down") });

    const response = await GET(request("?email=maybe%40startup.com"));

    expect(location(response)).toContain("sent=1");
    expect(sendSigninCode).toHaveBeenCalledWith("maybe@startup.com", "http://localhost");
  });

  it("bounces to sign-in with signup_disabled when the gate is closed for a new email", async () => {
    isSignupAllowed.mockResolvedValue(false);

    const response = await GET(request("?email=founder%40startup.com"));

    expect(location(response)).toContain("error=signup_disabled");
  });

  it("rate-limits the public entry", async () => {
    allowSignupStart.mockReturnValue(false);

    const response = await GET(request("?email=founder%40startup.com"));

    expect(location(response)).toContain("error=rate_limited");
  });
});
