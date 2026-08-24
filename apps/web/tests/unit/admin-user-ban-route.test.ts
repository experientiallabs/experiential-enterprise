import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));

import { DELETE, PUT } from "@/app/api/admin/users/[userId]/ban/route";

const context = { params: Promise.resolve({ userId: "user-1" }) };

function banRequest(reason: unknown = "Fraudulent gateway usage") {
  return new Request("https://platform.example/api/admin/users/user-1/ban", {
    body: JSON.stringify({ reason }),
    headers: { "content-type": "application/json" },
    method: "PUT"
  });
}

function unbanRequest() {
  return new Request("https://platform.example/api/admin/users/user-1/ban", {
    method: "DELETE"
  });
}

function adminClient({ userExists = true }: { userExists?: boolean } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const client = {
    rpc,
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue(
          userExists
            ? { data: { user: { id: "user-1" } }, error: null }
            : { data: { user: null }, error: { message: "missing" } }
        )
      }
    }
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  isPlatformAdmin.mockResolvedValue(true);
  requireAuthenticatedUser.mockResolvedValue({ id: "operator-1" });
});

describe("PUT /api/admin/users/[userId]/ban", () => {
  it("hides the endpoint from non-platform users", async () => {
    isPlatformAdmin.mockResolvedValue(false);

    const response = await PUT(banRequest() as never, context);

    expect(response.status).toBe(404);
    expect(createServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it("bans through the atomic RPC with actor provenance", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest("  Fraudulent gateway usage  ") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: "user-1", banned: true });
    // The single RPC carries the whole ban: banned_until, the record, key
    // revocation, and session teardown commit or roll back together.
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("record_user_ban", {
      in_user_id: "user-1",
      in_banned_by: "operator-1",
      in_reason: "Fraudulent gateway usage"
    });
  });

  it("requires a reason", async () => {
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest("   ") as never, context);

    expect(response.status).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("refuses self-banning", async () => {
    requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
    const client = adminClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PUT(banRequest() as never, context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "You cannot ban your own account."
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("rejects unknown accounts without banning", async () => {
    const client = adminClient({ userExists: false });
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

describe("DELETE /api/admin/users/[userId]/ban", () => {
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
    expect(client.rpc).toHaveBeenCalledWith("clear_user_ban", { in_user_id: "user-1" });
  });

  it("404s for unknown accounts", async () => {
    const client = adminClient({ userExists: false });
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
