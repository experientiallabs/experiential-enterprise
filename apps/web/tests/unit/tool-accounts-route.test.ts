import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const orgIsYcCompany = vi.hoisted(() => vi.fn());
const listToolAccounts = vi.hoisted(() => vi.fn());
const upsertToolAccount = vi.hoisted(() => vi.fn());
const fetchToolAccountBalance = vi.hoisted(() => vi.fn());
const deleteToolAccount = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({
  AuthRequiredError: class extends Error {},
  requireAuthenticatedUser
}));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/billing/tool-accounts-server", () => ({ orgIsYcCompany }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({
    listToolAccounts,
    upsertToolAccount,
    fetchToolAccountBalance,
    deleteToolAccount
  })
}));

import { GET as listRoute } from "@/app/api/orgs/[orgId]/tool-accounts/route";
import {
  DELETE as deleteRoute,
  PUT as putRoute
} from "@/app/api/orgs/[orgId]/tool-accounts/[vendor]/route";
import { POST as fetchBalanceRoute } from "@/app/api/orgs/[orgId]/tool-accounts/[vendor]/fetch-balance/route";

function listContext() {
  return { params: Promise.resolve({ orgId: "org-1" }) };
}

function vendorContext(vendor: string) {
  return { params: Promise.resolve({ orgId: "org-1", vendor }) };
}

function put(body: unknown): Request {
  return new Request("http://localhost/api/orgs/org-1/tool-accounts/e2b", {
    body: JSON.stringify(body),
    method: "PUT"
  });
}

const post = new Request("http://localhost", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockResolvedValue("org-uuid");
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
  orgIsYcCompany.mockResolvedValue(false);
});

describe("GET /api/orgs/[orgId]/tool-accounts", () => {
  it("lists the org's tool accounts for a manager", async () => {
    listToolAccounts.mockResolvedValue([{ vendor: "e2b" }]);

    const response = await listRoute(new Request("http://localhost") as never, listContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ vendor: "e2b" }]);
    expect(listToolAccounts).toHaveBeenCalledWith("org-uuid");
  });

  it("hides the surface from a member who cannot manage it", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await listRoute(new Request("http://localhost") as never, listContext());

    expect(response.status).toBe(404);
    expect(listToolAccounts).not.toHaveBeenCalled();
  });
});

describe("YC gating on tool-account vendors", () => {
  it("404s a YC-gated vendor for a non-YC org, before any backend call", async () => {
    orgIsYcCompany.mockResolvedValue(false);

    const response = await putRoute(put({ declared_balance_usd: 10 }) as never, vendorContext("greptile"));

    expect(response.status).toBe(404);
    expect(upsertToolAccount).not.toHaveBeenCalled();
  });

  it("admits a YC-gated vendor for a YC org", async () => {
    orgIsYcCompany.mockResolvedValue(true);
    upsertToolAccount.mockResolvedValue({ vendor: "greptile" });

    const response = await putRoute(
      put({ declared_balance_usd: 10 }) as never,
      vendorContext("greptile")
    );

    expect(response.status).toBe(200);
    expect(upsertToolAccount).toHaveBeenCalledWith("org-uuid", "greptile", {
      declared_balance_usd: 10
    });
  });

  it("never gates E2B: it is admitted for a non-YC org", async () => {
    orgIsYcCompany.mockResolvedValue(false);
    upsertToolAccount.mockResolvedValue({ vendor: "e2b" });

    const response = await putRoute(put({ declared_balance_usd: 5 }) as never, vendorContext("e2b"));

    expect(response.status).toBe(200);
    // E2B never consults the YC check.
    expect(orgIsYcCompany).not.toHaveBeenCalled();
    expect(upsertToolAccount).toHaveBeenCalledWith("org-uuid", "e2b", { declared_balance_usd: 5 });
  });
});

describe("PUT /api/orgs/[orgId]/tool-accounts/[vendor]", () => {
  it("rejects a vendor outside the tracked set, before auth", async () => {
    const response = await putRoute(put({ declared_balance_usd: 1 }) as never, vendorContext("porter"));

    expect(response.status).toBe(400);
    expect(requireAuthenticatedUser).not.toHaveBeenCalled();
    expect(upsertToolAccount).not.toHaveBeenCalled();
  });

  it("rejects a negative declared balance", async () => {
    const response = await putRoute(put({ declared_balance_usd: -1 }) as never, vendorContext("e2b"));

    expect(response.status).toBe(400);
    expect(upsertToolAccount).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric declared balance but accepts null to stop tracking", async () => {
    const bad = await putRoute(put({ declared_balance_usd: "lots" }) as never, vendorContext("e2b"));
    expect(bad.status).toBe(400);

    upsertToolAccount.mockResolvedValue({ vendor: "e2b" });
    const cleared = await putRoute(put({ declared_balance_usd: null }) as never, vendorContext("e2b"));
    expect(cleared.status).toBe(200);
    expect(upsertToolAccount).toHaveBeenCalledWith("org-uuid", "e2b", { declared_balance_usd: null });
  });

  it("rejects a negative low-balance threshold", async () => {
    const response = await putRoute(
      put({ low_balance_threshold_usd: -5 }) as never,
      vendorContext("e2b")
    );

    expect(response.status).toBe(400);
    expect(upsertToolAccount).not.toHaveBeenCalled();
  });

  it("passes the dashboard secret through for a YC vendor", async () => {
    orgIsYcCompany.mockResolvedValue(true);
    upsertToolAccount.mockResolvedValue({ vendor: "cursor" });

    const response = await putRoute(
      put({ dashboard_secret: "hunter2" }) as never,
      vendorContext("cursor")
    );

    expect(response.status).toBe(200);
    expect(upsertToolAccount).toHaveBeenCalledWith("org-uuid", "cursor", {
      dashboard_secret: "hunter2"
    });
  });
});

describe("DELETE /api/orgs/[orgId]/tool-accounts/[vendor]", () => {
  it("disconnects the account and answers 204", async () => {
    deleteToolAccount.mockResolvedValue(undefined);

    const response = await deleteRoute(new Request("http://localhost") as never, vendorContext("e2b"));

    expect(response.status).toBe(204);
    expect(deleteToolAccount).toHaveBeenCalledWith("org-uuid", "e2b");
  });
});

describe("POST /api/orgs/[orgId]/tool-accounts/[vendor]/fetch-balance", () => {
  it("relays the backend fetch verdict verbatim", async () => {
    const verdict = {
      vendor: "e2b",
      kind: "reported",
      strategy: "deterministic",
      refreshed: true,
      balanceUsd: 42.5,
      source: "vendor_api",
      message: "E2B reports $42.50 remaining."
    };
    fetchToolAccountBalance.mockResolvedValue(verdict);

    const response = await fetchBalanceRoute(post as never, vendorContext("e2b"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(verdict);
    expect(fetchToolAccountBalance).toHaveBeenCalledWith("org-uuid", "e2b");
  });

  it("applies the YC gate: a gated vendor 404s for a non-YC org", async () => {
    orgIsYcCompany.mockResolvedValue(false);

    const response = await fetchBalanceRoute(post as never, vendorContext("devin"));

    expect(response.status).toBe(404);
    expect(fetchToolAccountBalance).not.toHaveBeenCalled();
  });

  it("hides fetch-balance from a member who cannot manage it", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await fetchBalanceRoute(post as never, vendorContext("e2b"));

    expect(response.status).toBe(404);
    expect(fetchToolAccountBalance).not.toHaveBeenCalled();
  });
});
