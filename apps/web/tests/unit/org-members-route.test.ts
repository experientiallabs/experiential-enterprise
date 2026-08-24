import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const requireOrg = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());
const addOrInviteMember = vi.hoisted(() => vi.fn());
const listOrgRoster = vi.hoisted(() => vi.fn());
const listOrgPendingInvites = vi.hoisted(() => vi.fn());
const isLastOrgAdmin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient, requireAuthenticatedUser }));
// The roster and the role writes gate through requireOrgId (id only); the invite
// path still needs the org's display name, so it keeps the full-record lookup.
vi.mock("@/lib/data-cache", () => ({ requireOrg }));
vi.mock("@/lib/members/manage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addOrInviteMember,
  listOrgRoster,
  listOrgPendingInvites,
  isLastOrgAdmin
}));

import { GET, POST } from "@/app/api/orgs/[orgId]/members/route";
import { DELETE, PATCH } from "@/app/api/orgs/[orgId]/members/[userId]/route";

const context = { params: Promise.resolve({ orgId: "org-1" }) };
const memberContext = { params: Promise.resolve({ orgId: "org-1", userId: "user-2" }) };

function request(method: string, payload?: unknown) {
  const value = new Request("https://platform.example/api/orgs/org-1/members", {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method
  });
  Object.defineProperty(value, "nextUrl", { value: new URL(value.url) });
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrg.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
  requireOrgId.mockResolvedValue("org-1");
  createServerSupabaseClient.mockResolvedValue({});
  createServiceRoleSupabaseClient.mockReturnValue({});
  isPlatformAdmin.mockResolvedValue(false);
  isLastOrgAdmin.mockResolvedValue(false);
});

describe("GET /api/orgs/[orgId]/members", () => {
  it("returns the roster to every member; invites only to managers", async () => {
    isOrgAdmin.mockResolvedValue(false);
    listOrgRoster.mockResolvedValue([
      { userId: "user-1", email: "a@acme.co", role: "user", createdAt: "", isExperientialAdmin: false }
    ]);

    const response = await GET(request("GET") as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      can_manage: false,
      invites: [],
      members: [{ userId: "user-1" }]
    });
    expect(listOrgPendingInvites).not.toHaveBeenCalled();
  });

  it("includes pending invites for org admins", async () => {
    isOrgAdmin.mockResolvedValue(true);
    listOrgRoster.mockResolvedValue([]);
    listOrgPendingInvites.mockResolvedValue([{ id: "invite-1", email: "p@x.co", role: "user" }]);

    const response = await GET(request("GET") as never, context);

    await expect(response.json()).resolves.toMatchObject({
      can_manage: true,
      invites: [{ id: "invite-1" }]
    });
  });
});

describe("POST /api/orgs/[orgId]/members", () => {
  it("hides the mutation from non-admin members as not-found", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await POST(request("POST", { email: "n@x.co", role: "user" }) as never, context);

    expect(response.status).toBe(404);
    expect(addOrInviteMember).not.toHaveBeenCalled();
  });

  it("runs the shared add-or-invite flow for org admins", async () => {
    isOrgAdmin.mockResolvedValue(true);
    addOrInviteMember.mockResolvedValue({
      action: "added",
      status: 201,
      membership: { org_id: "org-1", user_id: "user-9", role: "user" }
    });

    const response = await POST(request("POST", { email: "n@x.co", role: "user" }) as never, context);

    expect(response.status).toBe(201);
    expect(addOrInviteMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: "org-1", orgName: "Acme", email: "n@x.co", role: "user" })
    );
  });

  it("rejects roles outside the two-rung ladder", async () => {
    isOrgAdmin.mockResolvedValue(true);

    const response = await POST(
      request("POST", { email: "n@x.co", role: "viewer" }) as never,
      context
    );

    expect(response.status).toBe(400);
  });
});

describe("PATCH and DELETE /api/orgs/[orgId]/members/[userId]", () => {
  function memberTableClient() {
    const calls: Record<string, unknown[]> = { update: [], delete: [] };
    const client = {
      calls,
      from: vi.fn(() => ({
        update: (row: unknown) => {
          calls.update.push(row);
          const chain = {
            eq: () => chain,
            select: async () => ({
              data: [{ org_id: "org-1", user_id: "user-2", role: "admin" }],
              error: null
            })
          };
          return chain;
        },
        delete: () => {
          calls.delete.push(null);
          const chain = {
            eq: () => chain,
            select: async () => ({ data: [{ user_id: "user-2" }], error: null })
          };
          return chain;
        }
      }))
    };
    return client;
  }

  it("refuses to demote or remove the last admin", async () => {
    isOrgAdmin.mockResolvedValue(true);
    isLastOrgAdmin.mockResolvedValue(true);

    const patch = await PATCH(request("PATCH", { role: "user" }) as never, memberContext);
    const remove = await DELETE(request("DELETE") as never, memberContext);

    expect(patch.status).toBe(409);
    expect(remove.status).toBe(409);
  });

  it("updates a role for org admins", async () => {
    isOrgAdmin.mockResolvedValue(true);
    const client = memberTableClient();
    createServiceRoleSupabaseClient.mockReturnValue(client);

    const response = await PATCH(request("PATCH", { role: "admin" }) as never, memberContext);

    expect(response.status).toBe(200);
    expect(client.calls.update).toEqual([{ role: "admin" }]);
  });

  it("hides member mutations from non-admins", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await DELETE(request("DELETE") as never, memberContext);

    expect(response.status).toBe(404);
  });
});
