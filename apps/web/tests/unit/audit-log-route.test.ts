import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgId = vi.hoisted(() => vi.fn());
const getDataSource = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({ getDataSource }));

import { GET } from "@/app/api/orgs/[orgId]/audit-log/route";

const context = { params: Promise.resolve({ orgId: "acme" }) };

const LIST = { org_id: "org-1", events: [] };

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgId.mockResolvedValue("org-1");
});

describe("GET /api/orgs/[orgId]/audit-log", () => {
  it("proxies the listing with the canonicalized org id, filters, and cursor", async () => {
    const getOrgAuditLog = vi.fn(async () => LIST);
    getDataSource.mockReturnValue({ getOrgAuditLog });

    const response = await GET(
      new Request(
        "http://localhost/api/orgs/acme/audit-log?action=keys.rotate&object_type=api_key&before=2026-08-20T10:00:00Z&limit=50"
      ),
      context
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(LIST);
    expect(getOrgAuditLog).toHaveBeenCalledWith("org-1", {
      action: "keys.rotate",
      objectType: "api_key",
      before: "2026-08-20T10:00:00Z",
      limit: 50
    });
  });

  it("streams the backend CSV through as a download for format=csv", async () => {
    const csv = "event_id,created_at,actor_kind\n";
    const getOrgAuditLogCsv = vi.fn(async () => csv);
    getDataSource.mockReturnValue({ getOrgAuditLogCsv });

    const response = await GET(
      new Request("http://localhost/api/orgs/acme/audit-log?format=csv"),
      context
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("audit-log.csv");
    await expect(response.text()).resolves.toBe(csv);
    expect(getOrgAuditLogCsv).toHaveBeenCalledWith("org-1", {
      action: null,
      objectType: null,
      before: null
    });
  });
});
