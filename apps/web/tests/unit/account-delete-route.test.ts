import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));

import { DELETE } from "@/app/api/account/route";

type Membership = { org_id: string; user_id: string; role: string };

function clientFor(memberships: Membership[], platformAdminIds: string[]) {
  const deleteUser = vi.fn().mockResolvedValue({ error: null });
  const client = {
    deleteUser,
    auth: { admin: { deleteUser } },
    from: vi.fn((table: string) => {
      if (table === "platform_admins") {
        return {
          select: async () => ({
            data: platformAdminIds.map((id) => ({ user_id: id })),
            error: null
          })
        };
      }
      if (table === "organization_members") {
        return {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            const filters: Record<string, string> = {};
            const chain = {
              eq: (column: string, value: string) => {
                filters[column] = value;
                return chain;
              },
              then: (resolve: (value: unknown) => void) => {
                const rows = memberships.filter((row) =>
                  Object.entries(filters).every(
                    ([column, value]) => row[column as keyof Membership] === value
                  )
                );
                resolve(
                  opts?.head === true ? { count: rows.length, error: null } : { data: rows, error: null }
                );
              }
            };
            return chain;
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    })
  };
  return client;
}

const request = new Request("https://platform.example/api/account", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
});

describe("DELETE /api/account", () => {
  it("deletes the auth user when nothing depends on them", async () => {
    const client = clientFor(
      [{ org_id: "org-1", user_id: "user-1", role: "user" }],
      ["someone-else"]
    );
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request as never);

    expect(response.status).toBe(204);
    expect(client.deleteUser).toHaveBeenCalledWith("user-1");
  });

  it("refuses the only admin of an org that has other members", async () => {
    const client = clientFor(
      [
        { org_id: "org-1", user_id: "user-1", role: "admin" },
        { org_id: "org-1", user_id: "user-2", role: "user" }
      ],
      ["someone-else"]
    );
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request as never);

    expect(response.status).toBe(409);
    expect(client.deleteUser).not.toHaveBeenCalled();
  });

  it("allows the sole member of their own org to delete themselves", async () => {
    const client = clientFor(
      [{ org_id: "org-1", user_id: "user-1", role: "admin" }],
      ["someone-else"]
    );
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request as never);

    expect(response.status).toBe(204);
  });

  it("refuses the only experiential admin", async () => {
    const client = clientFor([], ["user-1"]);
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await DELETE(request as never);

    expect(response.status).toBe(409);
    expect(client.deleteUser).not.toHaveBeenCalled();
  });
});
