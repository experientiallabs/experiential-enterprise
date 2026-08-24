import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const getOrgCapability = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  })
);

vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/capabilities", () => ({ getOrgCapability }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/components/settings/ProviderPolicyPanel", () => ({
  ProviderPolicyPanel: () => null
}));

import DataControlsPage from "@/app/(workspace)/settings/data-controls/page";

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
});

describe("settings/data-controls page enterprise gate", () => {
  it("404s when the org's data_controls capability is not available", async () => {
    getOrgCapability.mockResolvedValue("unlicensed");

    await expect(DataControlsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getOrgCapability).toHaveBeenCalledWith("org-1", "data_controls");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the panel for an admin when the capability is available", async () => {
    getOrgCapability.mockResolvedValue("available");

    await expect(DataControlsPage()).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});
