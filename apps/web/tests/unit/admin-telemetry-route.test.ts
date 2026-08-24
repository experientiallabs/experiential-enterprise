import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const getGatewayUsagePlatformDaily = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ getGatewayUsagePlatformDaily })
}));

import { GET } from "@/app/api/admin/telemetry/usage/route";

function request(search = ""): Request {
  return new Request(`https://platform.example/api/admin/telemetry/usage${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  getGatewayUsagePlatformDaily.mockResolvedValue({
    group_by: "day",
    rows: [
      {
        day: "2026-08-02",
        org_id: null,
        alias: null,
        requests: 16,
        input_tokens: 80,
        output_tokens: 45,
        spend_micro_usd: 2256
      }
    ]
  });
});

describe("GET /api/admin/telemetry/usage", () => {
  it("hides the endpoint from non-platform users and touches no data source", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(getGatewayUsagePlatformDaily).not.toHaveBeenCalled();
  });

  it("proxies the grouped platform read with the bounded window", async () => {
    const response = await GET(
      request("?group_by=org&from=2026-08-01&to=2026-08-02")
    );

    expect(response.status).toBe(200);
    expect(getGatewayUsagePlatformDaily).toHaveBeenCalledWith({
      groupBy: "org",
      from: "2026-08-01",
      to: "2026-08-02",
      limit: 2000
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].spend_micro_usd).toBe(2256);
  });

  it("defaults to the all-time day series", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(getGatewayUsagePlatformDaily).toHaveBeenCalledWith({
      groupBy: "day",
      from: undefined,
      to: undefined,
      limit: 2000
    });
  });

  it("rejects an unknown grouping at the boundary", async () => {
    const response = await GET(request("?group_by=member"));

    expect(response.status).toBe(400);
    expect(getGatewayUsagePlatformDaily).not.toHaveBeenCalled();
  });

  it("rejects an out-of-cap limit", async () => {
    const response = await GET(request("?limit=99999"));

    expect(response.status).toBe(400);
    expect(getGatewayUsagePlatformDaily).not.toHaveBeenCalled();
  });
});
