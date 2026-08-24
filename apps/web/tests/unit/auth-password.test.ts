import { describe, expect, it } from "vitest";

import {
  canChangePasswordForSession,
  hasPasswordAuthMethod,
  hasPasswordIdentity,
  hasRecoveryAuthMethod,
  parseChangePasswordPayload,
  parseResetPassword
} from "@/lib/auth/password";

describe("hasRecoveryAuthMethod", () => {
  it("detects GoTrue's recovery-compatible email-link methods in both amr forms", () => {
    expect(hasRecoveryAuthMethod({ amr: ["recovery"] })).toBe(true);
    expect(hasRecoveryAuthMethod({ amr: [{ method: "otp" }] })).toBe(true);
    expect(hasRecoveryAuthMethod({ amr: ["magiclink"] })).toBe(true);
  });

  it("is false for non-recovery sessions and malformed claims", () => {
    expect(hasRecoveryAuthMethod({ amr: [{ method: "password" }] })).toBe(false);
    expect(hasRecoveryAuthMethod({ amr: ["oauth"] })).toBe(false);
    expect(hasRecoveryAuthMethod({})).toBe(false);
    expect(hasRecoveryAuthMethod(null)).toBe(false);
  });
});

describe("parseResetPassword", () => {
  it("accepts a long-enough password", () => {
    expect(parseResetPassword({ password: "brand-new-pw" })).toEqual({ password: "brand-new-pw" });
  });

  it("rejects a short or missing password", () => {
    expect(() => parseResetPassword({ password: "123" })).toThrow(/at least/i);
    expect(() => parseResetPassword({})).toThrow(/at least/i);
    expect(() => parseResetPassword(null)).toThrow(/object/i);
  });
});

describe("parseChangePasswordPayload", () => {
  it("accepts matching new passwords", () => {
    expect(
      parseChangePasswordPayload({
        currentPassword: "current-secret",
        newPassword: "new-secret",
        confirmPassword: "new-secret"
      })
    ).toEqual({
      currentPassword: "current-secret",
      newPassword: "new-secret",
      confirmPassword: "new-secret"
    });
  });

  it("normalizes an absent or empty current password to null (first-password set)", () => {
    // Enforcement moved to the route: null is only honored for an account
    // that verifiably has no password; everyone else gets a 400 there.
    expect(
      parseChangePasswordPayload({
        currentPassword: "",
        newPassword: "new-secret",
        confirmPassword: "new-secret"
      }).currentPassword
    ).toBeNull();
    expect(
      parseChangePasswordPayload({
        newPassword: "new-secret",
        confirmPassword: "new-secret"
      }).currentPassword
    ).toBeNull();
    expect(() =>
      parseChangePasswordPayload({
        currentPassword: 7,
        newPassword: "new-secret",
        confirmPassword: "new-secret"
      })
    ).toThrowError(/current password/i);
  });

  it("requires a six-character new password", () => {
    expect(() =>
      parseChangePasswordPayload({
        currentPassword: "current-secret",
        newPassword: "short",
        confirmPassword: "short"
      })
    ).toThrowError(/at least 6/i);
  });

  it("requires a six-character password confirmation", () => {
    expect(() =>
      parseChangePasswordPayload({
        currentPassword: "current-secret",
        newPassword: "new-secret",
        confirmPassword: "short"
      })
    ).toThrowError(/confirmation.*at least 6/i);
  });

  it("requires confirmation to match", () => {
    expect(() =>
      parseChangePasswordPayload({
        currentPassword: "current-secret",
        newPassword: "new-secret",
        confirmPassword: "different-secret"
      })
    ).toThrowError(/match/i);
  });

  it("rejects reusing the current password", () => {
    expect(() =>
      parseChangePasswordPayload({
        currentPassword: "same-secret",
        newPassword: "same-secret",
        confirmPassword: "same-secret"
      })
    ).toThrowError(/different/i);
  });
});

describe("hasPasswordIdentity", () => {
  it("accepts email/password provider metadata", () => {
    expect(
      hasPasswordIdentity({
        app_metadata: { provider: "email", providers: ["github"] },
        identities: []
      })
    ).toBe(true);
    expect(
      hasPasswordIdentity({
        app_metadata: { provider: "github", providers: ["github", "email"] },
        identities: []
      })
    ).toBe(true);
    expect(
      hasPasswordIdentity({
        app_metadata: { provider: "github", providers: ["github"] },
        identities: [{ provider: "email" }]
      })
    ).toBe(true);
  });

  it("rejects OAuth-only provider metadata", () => {
    expect(
      hasPasswordIdentity({
        app_metadata: { provider: "google", providers: ["google"] },
        identities: [{ provider: "google" }]
      })
    ).toBe(false);
    expect(hasPasswordIdentity(null)).toBe(false);
  });
});

describe("hasPasswordAuthMethod", () => {
  it("accepts password auth methods", () => {
    expect(hasPasswordAuthMethod({ amr: [{ method: "password", timestamp: 1 }] })).toBe(true);
    expect(hasPasswordAuthMethod({ amr: ["password"] })).toBe(true);
  });

  it("rejects non-password auth methods", () => {
    expect(hasPasswordAuthMethod({ amr: [{ method: "otp", timestamp: 1 }] })).toBe(false);
    expect(hasPasswordAuthMethod({ amr: ["oauth"] })).toBe(false);
    expect(hasPasswordAuthMethod({})).toBe(false);
  });
});

describe("canChangePasswordForSession", () => {
  it("requires both an email provider and a password-authenticated session", () => {
    const emailIdentity = {
      app_metadata: { provider: "email", providers: ["email"] },
      identities: [{ provider: "email" }]
    };

    expect(
      canChangePasswordForSession(emailIdentity, {
        amr: [{ method: "password", timestamp: 1 }]
      })
    ).toBe(true);
    expect(
      canChangePasswordForSession(emailIdentity, {
        amr: [{ method: "otp", timestamp: 1 }]
      })
    ).toBe(false);
    expect(
      canChangePasswordForSession(
        {
          app_metadata: { provider: "google", providers: ["google"] },
          identities: [{ provider: "google" }]
        },
        { amr: [{ method: "password", timestamp: 1 }] }
      )
    ).toBe(false);
  });
});
