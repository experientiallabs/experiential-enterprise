import { beforeEach, describe, expect, it, vi } from "vitest";

// Next's redirect() throws; mirror that so HomePage stops at the first gate
// the way it does in production.
const redirect = vi.hoisted(() =>
  vi.fn((target: string): never => {
    throw new Error(`redirect:${target}`);
  })
);
const requireAuthorizedOrgIds = vi.hoisted(() => vi.fn());
const getAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, requireAuthorizedOrgIds };
});

import HomePage from "@/app/page";

async function redirectTarget(): Promise<string> {
  try {
    await HomePage();
  } catch {
    // The redirect mock throws by design.
  }
  expect(redirect).toHaveBeenCalledTimes(1);
  return redirect.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue({ id: "u1", email: "member@example.com" });
  requireAuthorizedOrgIds.mockResolvedValue(
    new Map([
      ["p1", "p1"],
      ["alpha", "p1"]
    ])
  );
});

describe("HomePage redirect gate", () => {
  it("sends a signed-out visitor to the public catalog at /models", async () => {
    getAuthenticatedUser.mockResolvedValue(null);

    expect(await redirectTarget()).toBe("/models");
    // Signed-out: the membership gate never runs.
    expect(requireAuthorizedOrgIds).not.toHaveBeenCalled();
  });

  it("routes a member to their Overview — there is no onboarding gate", async () => {
    expect(await redirectTarget()).toBe("/overview");
  });

  it("lands on the Overview regardless of how many orgs are listed", async () => {
    requireAuthorizedOrgIds.mockResolvedValue(
      new Map([
        ["p1", "p1"],
        ["p2", "p2"]
      ])
    );

    expect(await redirectTarget()).toBe("/overview");
  });

  it("routes a memberless user to /orgs to create a workspace first", async () => {
    requireAuthorizedOrgIds.mockResolvedValue(new Map());

    expect(await redirectTarget()).toBe("/orgs");
  });
});
