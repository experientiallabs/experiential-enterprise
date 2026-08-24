import { describe, expect, it } from "vitest";

import { hasSupabaseAuthCookie } from "@/lib/auth/cookies";

describe("hasSupabaseAuthCookie", () => {
  it("requires a Supabase auth token cookie", () => {
    expect(hasSupabaseAuthCookie([])).toBe(false);
    expect(hasSupabaseAuthCookie([{ name: "sb-local-auth-token" }])).toBe(true);
    expect(hasSupabaseAuthCookie([{ name: "sb-local-auth-token.0" }])).toBe(true);
    expect(hasSupabaseAuthCookie([{ name: "supabase-auth-token" }])).toBe(true);
    expect(hasSupabaseAuthCookie([{ name: "sb-local-code-verifier" }])).toBe(false);
  });
});
