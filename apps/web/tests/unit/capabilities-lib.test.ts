import { beforeEach, describe, expect, it, vi } from "vitest";

const getDataSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/data-source", () => ({ getDataSource }));

import { getOrgCapabilities, getOrgCapability } from "@/lib/capabilities";

beforeEach(() => {
  vi.clearAllMocks();
});

function withRegistry(capabilities: Record<string, string>) {
  const getOrgCapabilities = vi.fn(async () => ({ capabilities }));
  getDataSource.mockReturnValue({ getOrgCapabilities });
  return getOrgCapabilities;
}

describe("getOrgCapability", () => {
  it("reads the org's state from the backend registry", async () => {
    const getOrgCapabilities = withRegistry({ audit_log: "available", sso: "unlicensed" });

    await expect(getOrgCapability("org-1", "audit_log")).resolves.toBe("available");
    await expect(getOrgCapability("org-1", "sso")).resolves.toBe("unlicensed");
    expect(getOrgCapabilities).toHaveBeenCalledWith("org-1");
  });

  it("passes an absent state through (not-in-this-build renders like unlicensed)", async () => {
    withRegistry({ scim: "absent" });
    await expect(getOrgCapability("org-1", "scim")).resolves.toBe("absent");
  });

  it("fails closed when the registry fetch fails", async () => {
    const getOrgCapabilities = vi.fn(async () => {
      throw new Error("backend unreachable");
    });
    getDataSource.mockReturnValue({ getOrgCapabilities });

    await expect(getOrgCapability("org-1", "audit_log")).resolves.toBe("unlicensed");
  });

  it("fails closed when the key is missing from the response", async () => {
    withRegistry({});
    await expect(getOrgCapability("org-1", "teams")).resolves.toBe("unlicensed");
  });

  it("fails closed on an unrecognized state value", async () => {
    withRegistry({ audit_log: "enabled-ish" });
    await expect(getOrgCapability("org-1", "audit_log")).resolves.toBe("unlicensed");
  });
});

describe("getOrgCapabilities", () => {
  it("returns the full map from one registry fetch, fail-closed per key", async () => {
    const getOrgCapabilities_ = withRegistry({ audit_log: "available", teams: "available" });

    await expect(getOrgCapabilities("org-1")).resolves.toEqual({
      audit_log: "available",
      sso: "unlicensed",
      scim: "unlicensed",
      teams: "available",
      data_controls: "unlicensed"
    });
    expect(getOrgCapabilities_).toHaveBeenCalledTimes(1);
  });

  it("fails closed to an all-unlicensed map when the fetch fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("backend unreachable");
    });
    getDataSource.mockReturnValue({ getOrgCapabilities: failing });

    await expect(getOrgCapabilities("org-1")).resolves.toEqual({
      audit_log: "unlicensed",
      sso: "unlicensed",
      scim: "unlicensed",
      teams: "unlicensed",
      data_controls: "unlicensed"
    });
  });
});
