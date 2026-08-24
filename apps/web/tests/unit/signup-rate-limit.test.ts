import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  allowEmailSend,
  allowSignupStart,
  clientIp,
  releaseEmailSend
} from "@/lib/auth/signup-rate-limit";

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/signup", { headers });
}

describe("clientIp", () => {
  it("prefers the nginx-set X-Real-IP over any client-sent forwarded header", () => {
    const request = req({
      "x-real-ip": "9.9.9.9",
      "x-forwarded-for": "1.1.1.1, 9.9.9.9"
    });
    expect(clientIp(request)).toBe("9.9.9.9");
  });

  it("never trusts the leftmost (client-forgeable) X-Forwarded-For token", () => {
    // An attacker forges the first token; the trusted proxy appends the real
    // peer on the right, which is what we must key the limit on.
    const request = req({ "x-forwarded-for": "6.6.6.6, 10.0.0.5" });
    expect(clientIp(request)).toBe("10.0.0.5");
    expect(clientIp(request)).not.toBe("6.6.6.6");
  });

  it("falls back to unknown when no forwarded headers are present", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("allowSignupStart", () => {
  it("allows a burst up to the cap then blocks the same IP", () => {
    const ip = `test-ip-${Math.random()}`;
    for (let i = 0; i < 5; i += 1) {
      expect(allowSignupStart(ip)).toBe(true);
    }
    expect(allowSignupStart(ip)).toBe(false);
  });
});

describe("allowEmailSend", () => {
  it("permits one send per address then holds off within the cooldown", () => {
    const email = `cooldown-${Math.random()}@experientiallabs.ai`;
    expect(allowEmailSend(email)).toBe(true);
    expect(allowEmailSend(email)).toBe(false);
  });

  it("treats the address case-insensitively", () => {
    const email = `Mixed-${Math.random()}@Experiential.ai`;
    expect(allowEmailSend(email)).toBe(true);
    expect(allowEmailSend(email.toUpperCase())).toBe(false);
  });

  it("allows a retry after the downstream send fails", () => {
    const email = `retry-${Math.random()}@experientiallabs.ai`;
    expect(allowEmailSend(email)).toBe(true);
    releaseEmailSend(email);
    expect(allowEmailSend(email)).toBe(true);
  });
});
