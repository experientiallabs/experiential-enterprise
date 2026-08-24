import { beforeEach, describe, expect, it, vi } from "vitest";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const refreshProviderSpend = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({
  AuthRequiredError: class extends Error {},
  requireAuthenticatedUser
}));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ refreshProviderSpend })
}));

import { POST as spendRefresh } from "@/app/api/orgs/[orgId]/provider-connections/[provider]/spend-refresh/route";

function context(provider: string) {
  return { params: Promise.resolve({ orgId: "org-1", provider }) };
}

const request = new Request("http://localhost", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockResolvedValue("org-uuid");
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
});

describe("POST /api/orgs/[orgId]/provider-connections/[provider]/spend-refresh", () => {
  it("relays the backend reading verbatim", async () => {
    // The floor and the snapshot both come from the backend; this proxy adds
    // nothing but auth, exactly like the check route.
    const reading = {
      provider: "openrouter",
      kind: "reported",
      refreshed: true,
      staleness_floor_seconds: 300,
      next_refresh_at: null,
      message: "OpenRouter reports this account's credits and this key's usage directly.",
      snapshot: {
        taken_at: "2026-08-19T00:00:00Z",
        source: "provider_api",
        spend_usd: 41.2,
        credits_remaining_usd: 82.91,
        usage_limit_usd: 100,
        detail: { limit_reset: "daily" }
      }
    };
    refreshProviderSpend.mockResolvedValue(reading);

    const response = await spendRefresh(request as never, context("openrouter"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(reading);
    expect(refreshProviderSpend).toHaveBeenCalledWith("org-uuid", "openrouter");
  });

  it("relays the honest not-reportable state without inventing numbers", async () => {
    refreshProviderSpend.mockResolvedValue({
      provider: "gemini",
      kind: "not_reportable",
      refreshed: false,
      staleness_floor_seconds: 0,
      next_refresh_at: null,
      message: "Google doesn't expose billing for AI Studio keys.",
      snapshot: null
    });

    const response = await spendRefresh(request as never, context("gemini"));
    const body = (await response.json()) as { kind: string; snapshot: unknown };

    expect(body.kind).toBe("not_reportable");
    expect(body.snapshot).toBeNull();
  });

  it("rejects providers outside the widened set", async () => {
    const response = await spendRefresh(request as never, context("cohere"));

    expect(response.status).toBe(400);
    expect(refreshProviderSpend).not.toHaveBeenCalled();
  });

  it("hides the surface from members who cannot manage providers", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await spendRefresh(request as never, context("openrouter"));

    expect(response.status).toBe(404);
    expect(refreshProviderSpend).not.toHaveBeenCalled();
  });
});
