import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({
  // The bypass under test: platform admins pass every org gate.
  isPlatformAdmin: async () => true
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuthenticatedUser,
  createServerSupabaseClient: async () => ({
    from: (table: string) => ({
      // The membership read chains .eq("user_id", ...) (the explicit self
      // filter that keeps the switcher list to real memberships even for
      // platform admins, whose RLS admits every row); the organizations read
      // awaits the select directly. Support both shapes.
      select: (columns: string) => ({
        eq: (column: string, value: string) => selectRows(table, columns, column, value),
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown
        ) => selectRows(table, columns).then(resolve, reject)
      })
    })
  })
}));

vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({})
}));

import { requireOrgId } from "@/lib/auth/orgs";

describe("platform-admin org gate bypass", () => {
  beforeEach(() => {
    selectRows.mockReset();
    requireAuthenticatedUser.mockReset();
    requireAuthenticatedUser.mockResolvedValue({ id: "operator" });
  });

  it("authorizes every org from the select-all policy, memberless ones included", async () => {
    selectRows.mockImplementation((table: string) => {
      if (table === "organizations") {
        return Promise.resolve({
          data: [
            { id: "org-1", slug: "experiential-labs" },
            { id: "org-2", slug: "demo-examples" }
          ],
          error: null
        });
      }
      return Promise.resolve({ data: [], error: null });
    });

    // demo-examples has no members; only the platform-admin path can pass, and
    // the gate hands back the canonical id rather than echoing the slug.
    await expect(requireOrgId("demo-examples")).resolves.toBe("org-2");
    expect(selectRows).toHaveBeenCalledWith("organizations", "id, slug");
    // The membership read is started concurrently with the admin probe (it is the
    // answer for every non-admin), so an admin issues it too and then discards it.
    // Its result never reaches the gate: the memberless org above still resolves.
    expect(selectRows).toHaveBeenCalledWith(
      "organization_members",
      "organizations(id, slug)",
      "user_id",
      "operator"
    );
  });

  it("keeps the membership list to the caller's own rows, admin or not", async () => {
    // The select-all RLS policy hands a platform admin EVERY membership row,
    // so the query must self-filter: the switcher shows only orgs the caller
    // was actually invited to (the product owner); admins reach the rest via /admin.
    selectRows.mockImplementation(
      (table: string, _columns: string, column?: string, value?: string) => {
        if (table === "organization_members") {
          expect(column).toBe("user_id");
          expect(value).toBe("operator");
          return Promise.resolve({
            data: [{ organizations: { id: "org-1", slug: "experiential-labs" } }],
            error: null
          });
        }
        return Promise.resolve({ data: [], error: null });
      }
    );
    const { listMembershipOrgIds } = await import("@/lib/auth/orgs");
    const memberships = await listMembershipOrgIds();
    expect([...memberships.keys()].sort()).toEqual(["experiential-labs", "org-1"]);
  });
});
