import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRows = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const listOrgs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));

vi.mock("@/lib/auth/server", () => ({
  requireAuthenticatedUser,
  createServerSupabaseClient: async () => ({
    from: (table: string) => ({
      select: (columns: string) => ({
        eq: (column: string, value: string) => selectRows(table, columns, column, value),
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown
        ) => selectRows(table, columns).then(resolve, reject)
      })
    }),
    // The org-access gate's reads (E2): none of these orgs require SSO, so
    // requireOrgId reduces to the membership map exactly as before.
    rpc: async () => ({ data: false, error: null }),
    auth: { getClaims: async () => ({ data: { claims: {} }, error: null }) }

  })
}));

vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ listOrgs })
}));

import { requireOrgId } from "@/lib/auth/orgs";
import { DataSourceNotFoundError } from "@/lib/errors";

const membershipRows = {
  data: [{ organizations: { id: "org-1", slug: "demo" } }],
  error: null
};

describe("requireOrgId", () => {
  beforeEach(() => {
    selectRows.mockReset();
    requireAuthenticatedUser.mockReset();
    isPlatformAdmin.mockReset();
    listOrgs.mockReset();
    requireAuthenticatedUser.mockResolvedValue({ id: "member" });
    isPlatformAdmin.mockResolvedValue(false);
    selectRows.mockResolvedValue(membershipRows);
    listOrgs.mockResolvedValue([{ id: "org-1", slug: "demo" }]);
  });

  it("canonicalizes a slug URL to the org id without fetching the org list", async () => {
    // The whole point of the change: the membership query the gate already runs
    // carries the id, so a slug-addressed route never pays the backend org list.
    await expect(requireOrgId("demo")).resolves.toBe("org-1");
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it("returns the same id when the caller already addressed the org by uuid", async () => {
    await expect(requireOrgId("org-1")).resolves.toBe("org-1");
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it("rejects an org the caller has no membership in", async () => {
    await expect(requireOrgId("someone-else")).rejects.toBeInstanceOf(DataSourceNotFoundError);
  });

  it("rejects before any org read when the session is not authenticated", async () => {
    requireAuthenticatedUser.mockRejectedValue(new Error("Authentication required."));

    await expect(requireOrgId("demo")).rejects.toThrow("Authentication required.");
    expect(selectRows).not.toHaveBeenCalled();
  });

  it("starts the membership read without waiting for the admin probe", async () => {
    // The two reads used to be serial, so every member request paid two
    // round-trips to answer one question. Hold the admin probe open and assert
    // the membership query is already in flight.
    let releaseAdminProbe = (): void => {};
    isPlatformAdmin.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseAdminProbe = () => resolve(false);
      })
    );

    const pending = requireOrgId("demo");
    // Still inside the admin probe's await: the membership query must already
    // have been issued. Serial code cannot satisfy this.
    await vi.waitFor(() => {
      expect(selectRows).toHaveBeenCalledWith(
        "organization_members",
        "organizations(id, slug)",
        "user_id",
        expect.any(String)
      );
    });

    releaseAdminProbe();
    await expect(pending).resolves.toBe("org-1");
  });
});

describe("identifier collisions", () => {
  beforeEach(() => {
    requireAuthenticatedUser.mockResolvedValue({ id: "member" });
    isPlatformAdmin.mockResolvedValue(false);
  });

  it("a slug equal to another accessible org's uuid never hijacks id addressing", async () => {
    // Both orgs belong to the caller, and org-2's slug collides with org-1's
    // canonical uuid. Addressing by uuid must stay canonical; the colliding
    // slug is the identifier that loses.
    selectRows.mockResolvedValue({
      data: [
        { organizations: { id: "org-1", slug: "demo" } },
        { organizations: { id: "org-2", slug: "org-1" } }
      ],
      error: null
    });

    await expect(requireOrgId("org-1")).resolves.toBe("org-1");
    await expect(requireOrgId("demo")).resolves.toBe("org-1");
    await expect(requireOrgId("org-2")).resolves.toBe("org-2");
  });
});
