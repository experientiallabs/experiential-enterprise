import { afterEach, describe, expect, it } from "vitest";

import { readLastAuthMethod, recordAuthMethod } from "@/lib/auth/last-used";

afterEach(() => {
  window.localStorage.clear();
});

describe("last-used auth method", () => {
  it("round-trips a recorded method", () => {
    expect(readLastAuthMethod()).toBeNull();
    recordAuthMethod("github");
    expect(readLastAuthMethod()).toBe("github");
    recordAuthMethod("password");
    expect(readLastAuthMethod()).toBe("password");
  });

  it("ignores values that are not auth methods", () => {
    window.localStorage.setItem("explabs.last-auth-method", "not-a-method");
    expect(readLastAuthMethod()).toBeNull();
  });
});
