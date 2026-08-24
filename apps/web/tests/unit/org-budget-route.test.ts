import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";

const getOrgBudget = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({ getOrgBudget })
  };
});

vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, requireOrgId };
});

import { GET } from "@/app/api/orgs/[orgId]/budget/route";

const context = { params: Promise.resolve({ orgId: "demo" }) };

beforeEach(() => {
  getOrgBudget.mockReset();
  requireOrgId.mockReset();
  requireOrgId.mockResolvedValue("org-1");
});

describe("GET /api/orgs/[orgId]/budget", () => {
  it("resolves the slug, gates access, and keys the backend read on the UUID", async () => {
    const budget = {
      spend_usd: 7.125,
      billable_spend_usd: 7.125,
      credit_granted_usd: 20,
      credit_balance_usd: 12.875
    };
    getOrgBudget.mockResolvedValue(budget);

    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ budget });
    expect(requireOrgId).toHaveBeenCalledWith("demo");
    expect(getOrgBudget).toHaveBeenCalledWith("org-1");
  });

  it("preserves a not-found response for inaccessible orgs", async () => {
    requireOrgId.mockRejectedValue(new DataSourceNotFoundError("Organization not found: demo"));

    const response = await GET(new Request("http://localhost"), context);

    expect(response.status).toBe(404);
    expect(getOrgBudget).not.toHaveBeenCalled();
  });
});
