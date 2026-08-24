import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";

const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const checkModelDeployment = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({
  AuthRequiredError: class extends Error {},
  requireAuthenticatedUser
}));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ checkModelDeployment })
}));

import { POST as checkDeployment } from "@/app/api/orgs/[orgId]/provider-connections/[provider]/deployment-check/route";

function context(provider: string) {
  return { params: Promise.resolve({ orgId: "org-1", provider }) };
}

function request(body: unknown) {
  return new Request("http://localhost", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockResolvedValue("org-uuid");
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
});

describe("POST /api/orgs/[orgId]/provider-connections/[provider]/deployment-check", () => {
  it("relays the model-scoped verdict verbatim", async () => {
    const verdict = {
      provider: "azure_openai",
      model: "gpt-5.5",
      deployment: "my-dep",
      deployed: false,
      checked_at: "2026-08-19T00:00:00Z",
      detail: {
        provider_code: "DeploymentNotFound",
        remediation:
          "You have a key, but this model isn't deployed: the resource has no deployment " +
          "named 'my-dep'."
      }
    };
    checkModelDeployment.mockResolvedValue(verdict);

    const response = await checkDeployment(
      request({ model: "gpt-5.5" }) as never,
      context("azure_openai")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(verdict);
    expect(checkModelDeployment).toHaveBeenCalledWith("org-uuid", "azure_openai", {
      model: "gpt-5.5"
    });
  });

  it("forwards the inline deployment mapping when one is given", async () => {
    checkModelDeployment.mockResolvedValue({ deployed: true });

    const response = await checkDeployment(
      request({ model: "gpt-5.5", deployment: "  my-new-dep  " }) as never,
      context("azure_openai")
    );

    expect(response.status).toBe(200);
    expect(checkModelDeployment).toHaveBeenCalledWith("org-uuid", "azure_openai", {
      model: "gpt-5.5",
      deployment: "my-new-dep"
    });
  });

  it("requires the model slug", async () => {
    const response = await checkDeployment(request({}) as never, context("azure_openai"));

    expect(response.status).toBe(400);
    expect(checkModelDeployment).not.toHaveBeenCalled();
  });

  it("rejects providers outside the widened set", async () => {
    const response = await checkDeployment(
      request({ model: "gpt-5.5" }) as never,
      context("cohere")
    );

    expect(response.status).toBe(400);
    expect(checkModelDeployment).not.toHaveBeenCalled();
  });

  it("hides the surface from members who cannot manage keys", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await checkDeployment(
      request({ model: "gpt-5.5" }) as never,
      context("azure_openai")
    );

    expect(response.status).toBe(404);
    expect(checkModelDeployment).not.toHaveBeenCalled();
  });

  it("forwards the backend's 404 for an unmapped model", async () => {
    checkModelDeployment.mockRejectedValue(
      new DataSourceNotFoundError("No Azure deployment is mapped for model 'gpt-5.5'")
    );

    const response = await checkDeployment(
      request({ model: "gpt-5.5" }) as never,
      context("azure_openai")
    );

    expect(response.status).toBe(404);
  });
});
