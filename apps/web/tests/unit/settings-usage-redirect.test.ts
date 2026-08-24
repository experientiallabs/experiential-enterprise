import { beforeEach, describe, expect, it, vi } from "vitest";

// Next's redirect() throws; mirror that so the pages stop at the redirect the
// way they do in production.
const redirect = vi.hoisted(() =>
  vi.fn((target: string): never => {
    throw new Error(`redirect:${target}`);
  })
);

vi.mock("next/navigation", () => ({ redirect }));

import LegacySettingsUsagePage from "@/app/(workspace)/settings/usage/page";
import SettingsIndexPage from "@/app/(workspace)/settings/page";

async function usageRedirectTarget(searchParams: { topup?: string }): Promise<string> {
  try {
    await LegacySettingsUsagePage({ searchParams: Promise.resolve(searchParams) });
  } catch {
    // The redirect mock throws by design.
  }
  expect(redirect).toHaveBeenCalledTimes(1);
  return redirect.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/settings/usage redirect", () => {
  it("sends the old usage section to /credits", async () => {
    expect(await usageRedirectTarget({})).toBe("/credits");
  });

  it("forwards the Stripe return flag from sessions minted before the move", async () => {
    expect(await usageRedirectTarget({ topup: "success" })).toBe("/credits?topup=success");
    redirect.mockClear();
    expect(await usageRedirectTarget({ topup: "cancelled" })).toBe("/credits?topup=cancelled");
  });

  it("drops any other query value instead of forwarding it", async () => {
    expect(await usageRedirectTarget({ topup: "surprise" })).toBe("/credits");
  });
});

describe("/settings index", () => {
  it("lands on the first section (Connections) now that usage and API keys moved out", () => {
    try {
      SettingsIndexPage();
    } catch {
      // The redirect mock throws by design.
    }
    expect(redirect).toHaveBeenCalledWith("/settings/connections");
  });
});
