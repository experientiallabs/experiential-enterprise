import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgId = vi.hoisted(() => vi.fn());
const getDataSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({ getDataSource }));

import { GET } from "@/app/api/orgs/[orgId]/capabilities/route";
import { DataSourceNotFoundError } from "@/lib/errors";

const context = { params: Promise.resolve({ orgId: "acme" }) };

const LISTING = {
  capabilities: { audit_log: "available", sso: "unlicensed", scim: "unlicensed", teams: "unlicensed" }
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgId.mockResolvedValue("org-1");
});

describe("GET /api/orgs/[orgId]/capabilities", () => {
  it("proxies the registry listing with the canonicalized org id", async () => {
    const getOrgCapabilities = vi.fn(async () => LISTING);
    getDataSource.mockReturnValue({ getOrgCapabilities });

    const response = await GET(new Request("http://localhost/api/orgs/acme/capabilities"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(LISTING);
    expect(getOrgCapabilities).toHaveBeenCalledWith("org-1");
  });

  it("forwards the backend's 404 (non-members cannot enumerate the org)", async () => {
    const getOrgCapabilities = vi.fn(async () => {
      throw new DataSourceNotFoundError("Organization not found: org-1");
    });
    getDataSource.mockReturnValue({ getOrgCapabilities });

    const response = await GET(new Request("http://localhost/api/orgs/acme/capabilities"), context);

    expect(response.status).toBe(404);
  });
});
