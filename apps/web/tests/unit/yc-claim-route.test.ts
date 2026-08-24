import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError, DataSourceRequestError } from "@/lib/errors";

const postYcClaim = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({ postYcClaim })
  };
});

vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, requireOrgId };
});

import { POST } from "@/app/api/orgs/[orgId]/yc/claim/route";

const context = { params: Promise.resolve({ orgId: "demo" }) };

beforeEach(() => {
  postYcClaim.mockReset();
  requireOrgId.mockReset();
  requireOrgId.mockResolvedValue("org-1");
});

describe("POST /api/orgs/[orgId]/yc/claim", () => {
  it("resolves the slug, gates on membership, and forwards the grant result", async () => {
    const claim = {
      granted_usd: 526,
      expires_at: "2026-11-19T00:00:00+00:00",
      balance_usd: 546
    };
    postYcClaim.mockResolvedValue(claim);

    const response = await POST(new Request("http://localhost", { method: "POST" }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(claim);
    expect(requireOrgId).toHaveBeenCalledWith("demo");
    expect(postYcClaim).toHaveBeenCalledWith("org-1");
  });

  it("forwards the backend's duplicate-claim 409 with its message verbatim", async () => {
    postYcClaim.mockRejectedValue(
      new DataSourceRequestError("This account has already claimed the YC grant.", 409, {
        action: null,
        code: "yc_already_claimed"
      })
    );

    const response = await POST(new Request("http://localhost", { method: "POST" }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This account has already claimed the YC grant.",
      code: "yc_already_claimed"
    });
  });

  it("hides inaccessible orgs behind the standard not-found response", async () => {
    requireOrgId.mockRejectedValue(new DataSourceNotFoundError("Organization not found: demo"));

    const response = await POST(new Request("http://localhost", { method: "POST" }), context);

    expect(response.status).toBe(404);
    expect(postYcClaim).not.toHaveBeenCalled();
  });
});
