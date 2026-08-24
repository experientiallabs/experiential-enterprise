import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const getServingRequestAudit = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return { ...actual, getDataSource: () => ({ getServingRequestAudit }) };
});

import { GET as getAudit } from "@/app/api/admin/serving-requests/[requestId]/route";

const context = { params: Promise.resolve({ requestId: "req1" }) };

function request(): Request {
  return new Request("http://localhost/api/admin/serving-requests/req1");
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  getServingRequestAudit.mockResolvedValue({ request: {}, org: null });
});

describe("the routing-audit proxy", () => {
  it("returns the audit uncached for a platform operator", async () => {
    const response = await getAudit(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(getServingRequestAudit).toHaveBeenCalledWith("req1");
  });

  // Not-found rather than forbidden, and the data source is never reached: a
  // tenant must not be able to learn that a per-call routing audit exists.
  it("is a not-found for a non-admin and fetches nothing", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await getAudit(request(), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(getServingRequestAudit).not.toHaveBeenCalled();
  });
});
