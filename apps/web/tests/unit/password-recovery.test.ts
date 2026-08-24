import { beforeEach, describe, expect, it } from "vitest";

import {
  createPasswordRecoveryTicket,
  recoverySessionIdentity,
  sessionIdFromAccessToken,
  verifyPasswordRecoveryTicket
} from "@/lib/auth/password-recovery";

const IDENTITY = { userId: "user-1", sessionId: "session-1" };

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

describe("password recovery tickets", () => {
  it("accepts only the user and Supabase session it was minted for", () => {
    const now = Date.UTC(2026, 7, 22);
    const ticket = createPasswordRecoveryTicket(IDENTITY, now);

    expect(verifyPasswordRecoveryTicket(ticket, IDENTITY, now)).toBe(true);
    expect(
      verifyPasswordRecoveryTicket(ticket, { ...IDENTITY, sessionId: "session-2" }, now)
    ).toBe(false);
    expect(verifyPasswordRecoveryTicket(ticket, { ...IDENTITY, userId: "user-2" }, now)).toBe(
      false
    );
  });

  it("rejects expired and tampered tickets", () => {
    const now = Date.UTC(2026, 7, 22);
    const ticket = createPasswordRecoveryTicket(IDENTITY, now);

    expect(verifyPasswordRecoveryTicket(ticket, IDENTITY, now + 60 * 60 * 1000)).toBe(false);
    expect(verifyPasswordRecoveryTicket(`${ticket}x`, IDENTITY, now)).toBe(false);
  });
});

describe("recovery session identity", () => {
  it("reads the required user and session claims", () => {
    expect(recoverySessionIdentity({ sub: "user-1", session_id: "session-1" })).toEqual(IDENTITY);
    expect(recoverySessionIdentity({ sub: "user-1" })).toBeNull();
  });

  it("reads the session id from a returned Supabase access token", () => {
    const header = Buffer.from("{}").toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "user-1", session_id: "session-1" })
    ).toString("base64url");

    expect(sessionIdFromAccessToken(`${header}.${payload}.signature`)).toBe("session-1");
    expect(sessionIdFromAccessToken("not-a-jwt")).toBeNull();
  });
});
