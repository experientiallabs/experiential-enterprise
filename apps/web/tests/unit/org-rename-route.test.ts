import { beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrgId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", () => ({ requireAuthenticatedUser }));
vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));

import { PATCH } from "@/app/api/orgs/[orgId]/route";

const context = { params: Promise.resolve({ orgId: "org-1" }) };

function request(payload: unknown) {
  return new Request("https://platform.example/api/orgs/org-1", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrgId.mockResolvedValue("org-1");
  isPlatformAdmin.mockResolvedValue(false);
});

describe("PATCH /api/orgs/[orgId]", () => {
  it("hides the rename from non-admin members", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await PATCH(request({ name: "New Name" }) as never, context);

    expect(response.status).toBe(404);
  });

  it("renames for org admins and audits before/after; the slug never changes", async () => {
    isOrgAdmin.mockResolvedValue(true);
    const update = vi.fn((row: unknown) => {
      const chain = {
        eq: () => chain,
        select: () => ({
          single: async () => ({
            data: { id: "org-1", slug: "acme", name: (row as { name: string }).name },
            error: null
          })
        })
      };
      return chain;
    });
    // The audit snapshot reads the outgoing name before the rename lands.
    const readChain = {
      eq: () => readChain,
      maybeSingle: async () => ({ data: { name: "Old Name" }, error: null })
    };
    const rpc = vi.fn(async () => ({ error: null }));
    createServiceRoleSupabaseClient.mockReturnValue({
      from: () => ({ update, select: () => readChain }),
      rpc
    });

    const response = await PATCH(request({ name: "  Acme Robotics  " }) as never, context);

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ name: "Acme Robotics" });
    await expect(response.json()).resolves.toMatchObject({
      org: { slug: "acme", name: "Acme Robotics" }
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_audit_event",
      expect.objectContaining({
        p_action: "org.rename",
        p_actor_kind: "user",
        p_before: { name: "Old Name" },
        p_after: { name: "Acme Robotics" }
      })
    );
  });

  it("rejects blank and over-long names", async () => {
    isOrgAdmin.mockResolvedValue(true);

    const blank = await PATCH(request({ name: "   " }) as never, context);
    const long = await PATCH(request({ name: "x".repeat(81) }) as never, context);

    expect(blank.status).toBe(400);
    expect(long.status).toBe(400);
  });
});
