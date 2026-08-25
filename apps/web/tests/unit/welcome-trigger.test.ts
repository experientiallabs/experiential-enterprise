import { afterEach, describe, expect, it, vi } from "vitest";

import { claimWelcomeTrigger } from "@/lib/welcome-trigger";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(response: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(response) })
  );
}

describe("claimWelcomeTrigger", () => {
  it("parses a positive claim and carries the YC-company flag", async () => {
    mockFetch({ show: true, displayCreditUsd: 526, showApiKey: true, isYcCompany: true });
    expect(await claimWelcomeTrigger()).toEqual({
      show: true,
      displayCreditUsd: 526,
      showApiKey: true,
      isYcCompany: true
    });
  });

  it("coerces a non-numeric amount to null and defaults isYcCompany false", async () => {
    mockFetch({ show: true, displayCreditUsd: "526", showApiKey: false });
    expect(await claimWelcomeTrigger()).toEqual({
      show: true,
      displayCreditUsd: null,
      showApiKey: false,
      isYcCompany: false
    });
  });

  it("is silent on a non-ok response", async () => {
    mockFetch({ show: true }, false);
    expect(await claimWelcomeTrigger()).toEqual({
      show: false,
      displayCreditUsd: null,
      showApiKey: false,
      isYcCompany: false
    });
  });

  it("is silent when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await claimWelcomeTrigger()).toEqual({
      show: false,
      displayCreditUsd: null,
      showApiKey: false,
      isYcCompany: false
    });
  });
});
