import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgId = vi.hoisted(() => vi.fn());
const getGatewayUsageDaily = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ getGatewayUsageDaily })
}));

import { GET } from "@/app/api/gateway/usage/daily/route";
import { AuthRequiredError } from "@/lib/auth/server";

function request(query: string): Request {
  return new Request(`http://localhost/api/gateway/usage/daily?${query}`);
}

beforeEach(() => {
  requireOrgId.mockReset().mockResolvedValue("org-uuid-1");
  getGatewayUsageDaily.mockReset().mockResolvedValue({
    org_id: "org-uuid-1",
    scope: "self",
    group_by: "day",
    rows: []
  });
});

describe("GET /api/gateway/usage/daily", () => {
  it("rejects a missing org before touching auth or the backend", async () => {
    const response = await GET(request("scope=self"));
    expect(response.status).toBe(400);
    expect(requireOrgId).not.toHaveBeenCalled();
    expect(getGatewayUsageDaily).not.toHaveBeenCalled();
  });

  it("rejects unknown scope and group_by values at this boundary", async () => {
    expect((await GET(request("org=acme&scope=everyone"))).status).toBe(400);
    expect((await GET(request("org=acme&group_by=hour"))).status).toBe(400);
    expect(getGatewayUsageDaily).not.toHaveBeenCalled();
  });

  it("rejects a limit outside the backend's row cap", async () => {
    expect((await GET(request("org=acme&limit=0"))).status).toBe(400);
    expect((await GET(request("org=acme&limit=99999"))).status).toBe(400);
    expect((await GET(request("org=acme&limit=nope"))).status).toBe(400);
    expect(getGatewayUsageDaily).not.toHaveBeenCalled();
  });

  it("defaults to the personal per-day series and resolves org slug to id", async () => {
    const response = await GET(request("org=acme"));
    expect(response.status).toBe(200);
    expect(requireOrgId).toHaveBeenCalledWith("acme");
    expect(getGatewayUsageDaily).toHaveBeenCalledWith("org-uuid-1", {
      scope: "self",
      groupBy: "day",
      from: undefined,
      to: undefined,
      limit: 2000
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes scope, grouping, and day bounds through to the backend", async () => {
    await GET(request("org=acme&scope=org&group_by=member&from=2026-08-01&to=2026-08-19&limit=50"));
    expect(getGatewayUsageDaily).toHaveBeenCalledWith("org-uuid-1", {
      scope: "org",
      groupBy: "member",
      from: "2026-08-01",
      to: "2026-08-19",
      limit: 50
    });
  });

  it("accepts the per-day-per-model grouping (the stacked hero chart's read)", async () => {
    const response = await GET(request("org=acme&group_by=day_model&from=2026-07-21&to=2026-08-19"));
    expect(response.status).toBe(200);
    expect(getGatewayUsageDaily).toHaveBeenCalledWith(
      "org-uuid-1",
      expect.objectContaining({ groupBy: "day_model" })
    );
  });

  it("maps an unauthenticated read to 401", async () => {
    requireOrgId.mockRejectedValue(new AuthRequiredError());
    const response = await GET(request("org=acme"));
    expect(response.status).toBe(401);
  });
});
