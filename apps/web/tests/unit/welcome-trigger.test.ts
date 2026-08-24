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
  it("parses a positive claim", async () => {
    mockFetch({ show: true, displayCreditUsd: 526, showApiKey: true });
    expect(await claimWelcomeTrigger()).toEqual({
      show: true,
      displayCreditUsd: 526,
      showApiKey: true
    });
  });

  it("coerces a non-numeric amount to null", async () => {
    mockFetch({ show: true, displayCreditUsd: "526", showApiKey: false });
    expect(await claimWelcomeTrigger()).toEqual({
      show: true,
      displayCreditUsd: null,
      showApiKey: false
    });
  });

  it("is silent on a non-ok response", async () => {
    mockFetch({ show: true }, false);
    expect(await claimWelcomeTrigger()).toEqual({
      show: false,
      displayCreditUsd: null,
      showApiKey: false
    });
  });

  it("is silent when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await claimWelcomeTrigger()).toEqual({
      show: false,
      displayCreditUsd: null,
      showApiKey: false
    });
  });
});
