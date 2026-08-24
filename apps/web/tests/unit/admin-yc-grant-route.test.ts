import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const postAdminYcGrant = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/data-source", () => ({ getDataSource: () => ({ postAdminYcGrant }) }));

import { POST } from "@/app/api/admin/orgs/[orgId]/yc-grant/route";

const context = { params: Promise.resolve({ orgId: "org-1" }) };

function grantRequest(body: unknown) {
  return new Request("https://platform.example/api/admin/orgs/org-1/yc-grant", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  postAdminYcGrant.mockResolvedValue({
    granted_usd: 526,
    expires_at: "2027-01-01T00:00:00Z",
    balance_usd: 526,
    newly_applied: true,
    org_slug: "acme"
  });
});

describe("POST /api/admin/orgs/[orgId]/yc-grant", () => {
  it("applies the yc tag + grant with the given amount and expiry", async () => {
    const response = await POST(
      grantRequest({ amount_usd: 526, expires_at: "2027-01-01T00:00:00Z" }),
      context
    );

    expect(response.status).toBe(201);
    expect(postAdminYcGrant).toHaveBeenCalledWith("org-1", {
      amount_usd: 526,
      expires_at: "2027-01-01T00:00:00Z"
    });
    expect(await response.json()).toMatchObject({ granted_usd: 526, newly_applied: true });
  });

  it("passes an empty grant through (backend applies the launch defaults)", async () => {
    const response = await POST(grantRequest({}), context);

    expect(response.status).toBe(201);
    expect(postAdminYcGrant).toHaveBeenCalledWith("org-1", {});
  });

  it("ignores a blank expiry and a non-numeric amount", async () => {
    await POST(grantRequest({ amount_usd: "lots", expires_at: "   " }), context);
    expect(postAdminYcGrant).toHaveBeenCalledWith("org-1", {});
  });

  it("is 404 for a non-admin (the surface must not be enumerable)", async () => {
    isPlatformAdmin.mockResolvedValue(false);
    const response = await POST(grantRequest({}), context);
    expect(response.status).toBe(404);
    expect(postAdminYcGrant).not.toHaveBeenCalled();
  });
});
