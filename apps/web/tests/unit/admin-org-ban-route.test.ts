import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));

import { DELETE, PUT } from "@/app/api/admin/orgs/[orgId]/ban/route";

const context = { params: Promise.resolve({ orgId: "org-1" }) };

function banRequest(reason: unknown = "Coordinated credit abuse") {
  return new Request("https://platform.example/api/admin/orgs/org-1/ban", {
    body: JSON.stringify({ reason }),
    headers: { "content-type": "application/json" },
    method: "PUT"
  });
}

function unbanRequest() {
  return new Request("https://platform.example/api/admin/orgs/org-1/ban", {
    method: "DELETE"
  });
}

function adminClient({ orgExists = true }: { orgExists?: boolean } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const filterable = {
    eq: () => filterable,
    maybeSingle: async () => ({ data: orgExists ? { id: "org-1" } : null, error: null })
  };
  const client = {
    rpc,
    from: () => ({ select: () => filterable })
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  requireAuthenticatedUser.mockResolvedValue({ id: "operator-1" });
});

describe("PUT /api/admin/orgs/[orgId]/ban", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await PUT(banRequest() as never, context);

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("bans through the atomic RPC with actor provenance", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest("  Coordinated credit abuse  ") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ orgId: "org-1", banned: true });
    // The single RPC carries the whole ban: banned_at, the record, org-wide
    // key revocation, invite revocation, and the member sweep commit or roll
    // back together.
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("record_org_ban", {
      in_org_id: "org-1",
      in_banned_by: "operator-1",
      in_reason: "Coordinated credit abuse"
    });
  });

  it("requires a reason", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest("   ") as never, context);

    expect(response.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("rejects unknown organizations without banning", async () => {
    const client = adminClient({ orgExists: false });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest() as never, context);

    expect(response.status).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("surfaces an RPC failure with nothing applied", async () => {
    const client = adminClient();
    client.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest() as never, context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "db down" });
  });
});

describe("DELETE /api/admin/orgs/[orgId]/ban", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await DELETE(unbanRequest() as never, context);

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("unbans through the atomic RPC", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(unbanRequest() as never, context);

    expect(response.status).toBe(204);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("clear_org_ban", { in_org_id: "org-1" });
  });

  it("404s for unknown organizations", async () => {
    const client = adminClient({ orgExists: false });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(unbanRequest() as never, context);

    expect(response.status).toBe(404);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("surfaces an RPC failure", async () => {
    const client = adminClient();
    client.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(unbanRequest() as never, context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "db down" });
  });
});
