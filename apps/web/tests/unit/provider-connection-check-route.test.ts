import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const checkProviderConnection = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({
  AuthRequiredError: class extends Error {},
  requireAuthenticatedUser
}));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ checkProviderConnection })
}));

import { POST as checkConnection } from "@/app/api/orgs/[orgId]/provider-connections/[provider]/check/route";

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

describe("POST /api/orgs/[orgId]/provider-connections/[provider]/check", () => {
  it("relays the backend verdict verbatim", async () => {
    const verdict = {
      provider: "azure_openai",
      status: "invalid",
      status_detail: {
        provider_status: 401,
        provider_message: "Access denied due to invalid subscription key or wrong API endpoint.",
        remediation: "Copy KEY 1 from THIS resource's Keys and Endpoint page."
      },
      status_checked_at: "2026-08-19T00:00:00Z",
      status_source: "hookup_check"
    };
    checkProviderConnection.mockResolvedValue(verdict);

    const response = await checkConnection(request as never, context("azure_openai"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(verdict);
    expect(checkProviderConnection).toHaveBeenCalledWith("org-uuid", "azure_openai");
  });

  it("rejects providers outside the widened set", async () => {
    const response = await checkConnection(request as never, context("cohere"));

    expect(response.status).toBe(400);
    expect(checkProviderConnection).not.toHaveBeenCalled();
  });

  it("hides the surface from members who cannot manage keys", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await checkConnection(request as never, context("openai"));

    expect(response.status).toBe(404);
    expect(checkProviderConnection).not.toHaveBeenCalled();
  });

  it("forwards the backend's 404 for a provider that is not connected", async () => {
    checkProviderConnection.mockRejectedValue(
      new DataSourceNotFoundError("Provider connection not found: openai")
    );

    const response = await checkConnection(request as never, context("openai"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Provider connection not found: openai"
    });
  });
});
