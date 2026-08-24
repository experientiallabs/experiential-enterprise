import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { expiryTimestamp, mintApiKeySecret, parseCreateApiKeyPayload } from "@/lib/api-keys/keys";

describe("mintApiKeySecret", () => {
  it("mints an xpl_ secret whose hash and prefix derive from it", () => {
    const minted = mintApiKeySecret();

    expect(minted.secret).toMatch(/^xpl_[0-9a-f]{40}$/);
    expect(minted.keyPrefix).toBe(minted.secret.slice(0, 12));
    expect(minted.keySuffix).toBe(minted.secret.slice(-4));
    expect(minted.keyHash).toBe(createHash("sha256").update(minted.secret).digest("hex"));
  });

  it("mints unique secrets", () => {
    expect(mintApiKeySecret().secret).not.toBe(mintApiKeySecret().secret);
  });
});

describe("parseCreateApiKeyPayload", () => {
  it("accepts and trims a valid payload, defaulting to no expiry", () => {
    expect(parseCreateApiKeyPayload({ orgId: " org1 ", name: " prod " })).toEqual({
      orgId: "org1",
      name: "prod",
      expiresInDays: null,
      identityId: null
    });
  });

  it.each([[30], [60], [90]])("accepts the offered %s-day expiry", (days) => {
    expect(
      parseCreateApiKeyPayload({ orgId: "org1", name: "prod", expiresInDays: days })
    ).toEqual({ orgId: "org1", name: "prod", expiresInDays: days, identityId: null });
  });

  it("accepts and trims an explicit identityId", () => {
    expect(
      parseCreateApiKeyPayload({ orgId: "org1", name: "prod", identityId: " team-a " })
    ).toEqual({ orgId: "org1", name: "prod", expiresInDays: null, identityId: "team-a" });
  });

  it.each([
    ["missing orgId", { name: "prod" }],
    ["blank name", { orgId: "org1", name: "  " }],
    ["overlong name", { orgId: "org1", name: "x".repeat(81) }],
    ["non-object", "nope"],
    ["zero-day expiry", { orgId: "org1", name: "prod", expiresInDays: 0 }],
    ["fractional expiry", { orgId: "org1", name: "prod", expiresInDays: 1.5 }],
    ["non-preset expiry", { orgId: "org1", name: "prod", expiresInDays: 45 }],
    ["overlong expiry", { orgId: "org1", name: "prod", expiresInDays: 366 }],
    ["non-numeric expiry", { orgId: "org1", name: "prod", expiresInDays: "30" }]
  ])("rejects %s", (_label, payload) => {
    expect(() => parseCreateApiKeyPayload(payload)).toThrow();
  });
});

describe("expiryTimestamp", () => {
  it("returns null for a non-expiring key", () => {
    expect(expiryTimestamp(null)).toBeNull();
  });

  it("returns an ISO timestamp the given days ahead", () => {
    const before = Date.now();
    const stamp = expiryTimestamp(30);
    const after = Date.now();

    expect(stamp).not.toBeNull();
    const millis = new Date(stamp as string).getTime();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(millis).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(millis).toBeLessThanOrEqual(after + thirtyDays);
  });
});
