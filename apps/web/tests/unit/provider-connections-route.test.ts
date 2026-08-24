import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const checkProviderConnection = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({
  createServiceRoleSupabaseClient: () => ({ from, rpc }),
  isPlatformAdmin
}));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({
  AuthRequiredError: class extends Error {},
  requireAuthenticatedUser
}));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ checkProviderConnection })
}));

import {
  DELETE as deleteConnection,
  PATCH as patchConnection,
  PUT as putConnection
} from "@/app/api/orgs/[orgId]/provider-connections/[provider]/route";

function context(provider: string) {
  return { params: Promise.resolve({ orgId: "org-1", provider }) };
}

function put(body: unknown): Request {
  return new Request("http://localhost/api/orgs/org-1/provider-connections/openai", {
    body: JSON.stringify(body),
    method: "PUT"
  });
}

const AZURE_CONFIG = {
  endpoint: "https://my-resource.openai.azure.com",
  api_version: "2026-05-01",
  deployments: { "gpt-5.5": "my-gpt-55" }
};

const VALID_CHECK = {
  provider: "anthropic",
  status: "valid",
  status_detail: { remediation: "The key works." },
  status_checked_at: "2026-08-19T00:00:00Z",
  status_source: "hookup_check"
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockResolvedValue("org-uuid");
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
  rpc.mockResolvedValue({ data: [{ provider: "openai", credential_last4: "abcd" }], error: null });
  checkProviderConnection.mockResolvedValue(VALID_CHECK);
});

describe("PUT /api/orgs/[orgId]/provider-connections/[provider]", () => {
  it("stores an API-key-only provider with an empty config and never echoes the key", async () => {
    const response = await putConnection(
      put({ secret: "  sk-live-key  ", config: { endpoint: "ignored" } }) as never,
      context("anthropic")
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("upsert_provider_connection", {
      in_org_id: "org-uuid",
      in_provider: "anthropic",
      // Anthropic bills off the key alone, so anything else sent is dropped.
      in_config: {},
      in_secret: "sk-live-key",
      in_actor: "user-1"
    });
    // The save round-trip runs the hookup check and returns its verdict, so
    // the UI renders the outcome without a second request.
    expect(checkProviderConnection).toHaveBeenCalledWith("org-uuid", "anthropic");
    await expect(response.json()).resolves.toEqual({
      connection: { provider: "openai", credential_last4: "abcd" },
      check: VALID_CHECK,
      spendError: null
    });
  });

  it("keeps the save when the hookup check itself cannot run", async () => {
    // The key is already in Vault by the time the check runs; an unreachable
    // backend must not fail the PUT or invent a verdict.
    checkProviderConnection.mockRejectedValue(new Error("backend down"));

    const response = await putConnection(put({ secret: "sk-live-key" }) as never, context("anthropic"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { check: { status: string; status_detail: { remediation?: string } } };
    expect(body.check.status).toBe("unchecked");
    expect(body.check.status_detail.remediation).toContain("could not be reached");
  });

  it("stores Azure's endpoint, api version, and deployment map", async () => {
    const response = await putConnection(
      put({ secret: "azure-key", config: AZURE_CONFIG }) as never,
      context("azure_openai")
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "upsert_provider_connection",
      expect.objectContaining({ in_provider: "azure_openai", in_config: AZURE_CONFIG })
    );
  });

  it("refuses an Azure config that cannot address a deployment", async () => {
    // Each of these holds a valid key and still routes nothing, so the write is
    // refused here rather than failing at serving time.
    const cases: unknown[] = [
      { deployments: { "gpt-5.5": "my-gpt-55" } },
      { endpoint: AZURE_CONFIG.endpoint },
      { endpoint: AZURE_CONFIG.endpoint, deployments: {} },
      { endpoint: AZURE_CONFIG.endpoint, deployments: { "gpt-5.5": "" } },
      { endpoint: AZURE_CONFIG.endpoint, deployments: ["my-gpt-55"] },
      // WMO accepts only "v1" or a dated version; free text must fail at
      // Settings save, not inside a funded run.
      { ...AZURE_CONFIG, api_version: "latest" },
      { ...AZURE_CONFIG, api_version: "2024-6-1" }
    ];
    for (const config of cases) {
      const response = await putConnection(
        put({ secret: "azure-key", config }) as never,
        context("azure_openai")
      );
      expect(response.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider and an empty key", async () => {
    const unknown = await putConnection(put({ secret: "k" }) as never, context("cohere"));
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toEqual({
      error:
        "provider must be one of: openai, anthropic, gemini, azure_openai, openrouter, bedrock, fireworks, modal."
    });

    const blank = await putConnection(put({ secret: "   " }) as never, context("openai"));
    expect(blank.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires the Fireworks account id beside the key", async () => {
    // The account id feeds billing reads and is not discoverable from the key.
    const missing = await putConnection(put({ secret: "fw_key_12345" }) as never, context("fireworks"));
    expect(missing.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();

    const connected = await putConnection(
      put({ secret: "fw_key_12345", config: { account_id: "my-account" } }) as never,
      context("fireworks")
    );
    expect(connected.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "upsert_provider_connection",
      expect.objectContaining({
        in_provider: "fireworks",
        in_config: { account_id: "my-account" }
      })
    );
  });

  it("stores Modal's token pair as one JSON secret and names a wrong half", async () => {
    const swapped = await putConnection(
      put({ secret: { token_id: "as-secret", token_secret: "ak-id" } }) as never,
      context("modal")
    );
    expect(swapped.status).toBe(400);
    await expect(swapped.json()).resolves.toEqual({
      error: "The Modal token id must start with ak- (from modal.com → Settings → API tokens)."
    });

    const halfPasted = await putConnection(
      put({ secret: { token_id: "ak-id-1234" } }) as never,
      context("modal")
    );
    expect(halfPasted.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();

    const connected = await putConnection(
      put({ secret: { token_id: "ak-id-1234", token_secret: "as-secret-5678" } }) as never,
      context("modal")
    );
    expect(connected.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "upsert_provider_connection",
      expect.objectContaining({
        in_provider: "modal",
        in_config: {},
        in_secret: JSON.stringify({ token_id: "ak-id-1234", token_secret: "as-secret-5678" })
      })
    );
  });

  it("requires Bedrock's region and access-key id beside the secret", async () => {
    const missing = await putConnection(put({ secret: "aws-secret" }) as never, context("bedrock"));
    expect(missing.status).toBe(400);

    const connected = await putConnection(
      put({
        secret: "aws-secret",
        config: { region: "us-east-1", access_key_id: "AKIAEXAMPLEEXAMPLE" }
      }) as never,
      context("bedrock")
    );
    expect(connected.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "upsert_provider_connection",
      expect.objectContaining({
        in_provider: "bedrock",
        in_config: { region: "us-east-1", access_key_id: "AKIAEXAMPLEEXAMPLE" }
      })
    );
  });

  it("hides the provider surface from a member who cannot manage it", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await putConnection(put({ secret: "sk-live" }) as never, context("openai"));

    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/orgs/[orgId]/provider-connections/[provider]", () => {
  it("deletes the row and its Vault secret through the definer RPC", async () => {
    rpc.mockResolvedValue({ data: true, error: null });

    const response = await deleteConnection(new Request("http://localhost") as never, context("openai"));

    expect(response.status).toBe(204);
    expect(rpc).toHaveBeenCalledWith("delete_provider_connection", {
      in_org_id: "org-uuid",
      in_provider: "openai"
    });
  });

  it("404s when there was nothing connected to delete", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    const response = await deleteConnection(new Request("http://localhost") as never, context("openai"));

    expect(response.status).toBe(404);
  });
});

describe("PUT admin key (spend) slot", () => {
  it("stores the admin key through its own RPC after the main key", async () => {
    const response = await putConnection(
      put({ secret: "sk-ant-api03-main-key", spendSecret: "sk-ant-admin01-spend-key" }) as never,
      context("anthropic")
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenNthCalledWith(1, "upsert_provider_connection", expect.anything());
    expect(rpc).toHaveBeenNthCalledWith(2, "set_provider_connection_spend_credential", {
      in_org_id: "org-uuid",
      in_provider: "anthropic",
      in_secret: "sk-ant-admin01-spend-key",
      in_actor: "user-1"
    });
    // The hookup check runs after BOTH secrets land, so its verdict covers
    // the admin key too (status_detail.spend_key).
    expect(checkProviderConnection).toHaveBeenCalledWith("org-uuid", "anthropic");
  });

  it("reports the saved key with a spendError when the admin-key write fails", async () => {
    // The main credential upserts (and rotates the serving key); only the
    // optional admin-key RPC fails afterwards.
    rpc.mockImplementation((fn: string) =>
      fn === "set_provider_connection_spend_credential"
        ? Promise.resolve({ data: null, error: { message: "vault write failed" } })
        : Promise.resolve({
            data: [{ provider: "anthropic", credential_last4: "akey" }],
            error: null
          })
    );

    const response = await putConnection(
      put({ secret: "sk-ant-api03-main-key", spendSecret: "sk-ant-admin01-spend-key" }) as never,
      context("anthropic")
    );

    // Partial success, not a failed save: 200 with the connection and an
    // explicit spend-key error, never a 500 that hides the committed rotation.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { spendError: string | null; connection: unknown };
    expect(body.spendError).toBe("vault write failed");
    expect(body.connection).toBeTruthy();
  });

  it("refuses an inference key in the admin slot, naming both key types", async () => {
    const response = await putConnection(
      put({ secret: "sk-ant-api03-main-key", spendSecret: "sk-ant-api03-not-admin" }) as never,
      context("anthropic")
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("sk-ant-admin");
    expect(body.error).toContain("sk-ant-api");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an admin key in the main slot, naming both key types", async () => {
    const anthropicAdmin = await putConnection(
      put({ secret: "sk-ant-admin01-in-wrong-slot" }) as never,
      context("anthropic")
    );
    expect(anthropicAdmin.status).toBe(400);
    const anthropicBody = (await anthropicAdmin.json()) as { error: string };
    expect(anthropicBody.error).toContain("sk-ant-admin");
    expect(anthropicBody.error).toContain("sk-ant-api");

    const openaiAdmin = await putConnection(
      put({ secret: "sk-admin-in-wrong-slot" }) as never,
      context("openai")
    );
    expect(openaiAdmin.status).toBe(400);
    const openaiBody = (await openaiAdmin.json()) as { error: string };
    expect(openaiBody.error).toContain("sk-admin-");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses the admin slot on providers without one", async () => {
    const response = await putConnection(
      put({ secret: "sk-or-v1-key-1234", spendSecret: "sk-admin-anything" }) as never,
      context("openrouter")
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Anthropic and OpenAI");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("PATCH declared balance (self-reported gauge)", () => {
  function patch(body: unknown): Request {
    return new Request("http://localhost/api/orgs/org-1/provider-connections/openrouter", {
      body: JSON.stringify(body),
      method: "PATCH"
    });
  }

  function updateChain(row: unknown) {
    const select = vi.fn().mockResolvedValue({ data: [row], error: null });
    const eqProvider = vi.fn().mockReturnValue({ select });
    const eqOrg = vi.fn().mockReturnValue({ eq: eqProvider });
    const update = vi.fn().mockReturnValue({ eq: eqOrg });
    return { select, update };
  }

  it("declaring a balance also writes a self_reported snapshot", async () => {
    const { update } = updateChain({ id: "conn-1", provider: "openrouter" });
    const insert = vi.fn().mockResolvedValue({ error: null });
    from.mockImplementation((table: string) =>
      table === "provider_connections" ? { update } : { insert }
    );

    const response = await patchConnection(
      patch({ declared_balance_usd: 42.5 }) as never,
      context("openrouter")
    );

    expect(response.status).toBe(200);
    // The gauge is labeled at the source: the snapshot row says self_reported
    // so it can never masquerade as a provider read.
    expect(insert).toHaveBeenCalledWith({
      org_id: "org-uuid",
      connection_id: "conn-1",
      provider: "openrouter",
      credits_remaining_usd: 42.5,
      source: "self_reported"
    });
  });

  it("clearing the gauge writes no snapshot", async () => {
    const { update } = updateChain({ id: "conn-1", provider: "openrouter" });
    const insert = vi.fn().mockResolvedValue({ error: null });
    from.mockImplementation((table: string) =>
      table === "provider_connections" ? { update } : { insert }
    );

    const response = await patchConnection(
      patch({ declared_balance_usd: null }) as never,
      context("openrouter")
    );

    expect(response.status).toBe(200);
    expect(insert).not.toHaveBeenCalled();
  });
});
