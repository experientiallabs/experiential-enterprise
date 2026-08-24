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
vi.mock("@/components/settings/AuditLogPanel", () => ({ AuditLogPanel: () => null }));

import AuditLogPage from "@/app/(workspace)/settings/audit/page";

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
});

describe("settings/audit page enterprise gate", () => {
  it("404s when the org's audit_log capability is not available", async () => {
    getOrgCapability.mockResolvedValue("unlicensed");

    await expect(AuditLogPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getOrgCapability).toHaveBeenCalledWith("org-1", "audit_log");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the panel for an admin when the capability is available", async () => {
    getOrgCapability.mockResolvedValue("available");

    await expect(AuditLogPage()).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});
