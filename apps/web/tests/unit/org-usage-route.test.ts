import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";
import type { OrgUsageReport } from "@/lib/types";

const requireOrgId = vi.hoisted(() => vi.fn());
const getOrgUsage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({ getOrgUsage })
  };
});

import { GET } from "@/app/api/orgs/[orgId]/usage/route";

const context = { params: Promise.resolve({ orgId: "demo-slug" }) };
const report: OrgUsageReport = {
  credit: {
    spend_usd: 0.25,
    billable_spend_usd: 0.25,
    credit_granted_usd: 20,
    credit_balance_usd: 19.75,
    yc: null
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgId.mockResolvedValue("org-1");
  getOrgUsage.mockResolvedValue(report);
});

describe("GET /api/orgs/[orgId]/usage", () => {
  it("returns an uncached live rollup for the authorized canonical org", async () => {
    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(report);
    expect(requireOrgId).toHaveBeenCalledWith("demo-slug");
    expect(getOrgUsage).toHaveBeenCalledWith("org-1");
  });

  it("maps an unauthorized organization to the standard not-found response", async () => {
    requireOrgId.mockRejectedValue(new DataSourceNotFoundError("Organization not found"));

    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(404);
  });
});
