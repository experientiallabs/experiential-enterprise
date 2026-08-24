import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireAuthorizedOrgIds = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());
const getOrgBudget = vi.hoisted(() => vi.fn());
const getJoinOffer = vi.hoisted(() => vi.fn());
const cookieGet = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const isOrgSpendUnlocked = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((path: string): never => {
    throw new Error(`REDIRECT:${path}`);
  })
);

vi.mock("next/headers", () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/server", () => ({ getAuthenticatedUser }));
vi.mock("@/lib/auth/orgs", () => ({ requireAuthorizedOrgIds }));
vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/spend-unlock", () => ({ isOrgSpendUnlocked }));
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
vi.mock("@/lib/data-source", () => ({ getDataSource: () => ({ getOrgBudget, getJoinOffer }) }));

import OverviewPage from "@/app/(workspace)/overview/page";

describe("Overview YC-intent guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "founder@yc.com" });
    requireAuthorizedOrgIds.mockResolvedValue(new Set(["org-1"]));
    resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
    getOrgBudget.mockResolvedValue({ yc: null });
    getJoinOffer.mockResolvedValue({ offer: null });
    cookieGet.mockReturnValue(undefined);
    isPlatformAdmin.mockResolvedValue(false);
    isOrgAdmin.mockResolvedValue(false);
    isOrgSpendUnlocked.mockResolvedValue(true);
  });

  it("redirects an unserved YC intent to the claim surface", async () => {
    cookieGet.mockReturnValue({ name: "explabs_yc_intent", value: "1" });

    await expect(OverviewPage()).rejects.toThrow("REDIRECT:/signin?yc=1");
    expect(getOrgBudget).toHaveBeenCalledWith("org-1");
  });

  it("leaves an org already on the grant alone", async () => {
    cookieGet.mockReturnValue({ name: "explabs_yc_intent", value: "1" });
    getOrgBudget.mockResolvedValue({
      yc: { claimed_at: "x", expires_at: "y", remaining_estimate_usd: 300 }
    });

    await expect(OverviewPage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders normally without the marker, no budget read", async () => {
    await expect(OverviewPage()).resolves.toBeTruthy();
    expect(getOrgBudget).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("fails open when the budget read breaks — never blocks the signed-in home", async () => {
    cookieGet.mockReturnValue({ name: "explabs_yc_intent", value: "1" });
    getOrgBudget.mockRejectedValue(new Error("backend down"));

    await expect(OverviewPage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("still bounces the signed-out to the public door", async () => {
    getAuthenticatedUser.mockResolvedValue(null);

    await expect(OverviewPage()).rejects.toThrow("REDIRECT:/");
  });
});
