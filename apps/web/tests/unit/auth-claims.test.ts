import { describe, expect, it } from "vitest";

import { authenticatedUserFromClaims } from "@/lib/auth/claims";

describe("authenticatedUserFromClaims", () => {
  it("maps sub and email from verified claims", () => {
    const user = authenticatedUserFromClaims({
      sub: "11111111-1111-1111-1111-111111111111",
      email: "admin@experientiallabs.ai"
    });

    expect(user).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      email: "admin@experientiallabs.ai"
    });
  });

  it("collapses a missing or non-string email to null", () => {
    expect(authenticatedUserFromClaims({ sub: "user-1" })?.email).toBeNull();
    expect(authenticatedUserFromClaims({ sub: "user-1", email: 42 })?.email).toBeNull();
  });

  it("rejects claims without a subject", () => {
    expect(authenticatedUserFromClaims({})).toBeNull();
    expect(authenticatedUserFromClaims({ email: "admin@experientiallabs.ai" })).toBeNull();
  });
});
