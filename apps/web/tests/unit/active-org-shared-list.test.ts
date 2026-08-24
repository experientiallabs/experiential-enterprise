import { beforeEach, describe, expect, it, vi } from "vitest";

// A faithful stand-in for React's request scope: `cache()` memoizes on
// (function identity, args) for the lifetime of one render. Vitest has no React
// request scope, and the real `cache()` degrades to a pass-through without one,
// so emulate it here. That is the whole subject of this suite: two accessors
// that wrap the same fetch under different identities cannot share it.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) {
        memo.set(key, fn(...args));
      }
      return memo.get(key) as R;
    };
  }
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined })
}));
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  }
}));

const ORGS = [{ id: "id-a", slug: "acme", name: "Acme" }];
const orgIds = new Map([
  ["id-a", "id-a"],
  ["acme", "id-a"]
]);

vi.mock("@/lib/auth/orgs", () => ({
  requireAuthorizedOrgIds: async () => orgIds,
  listMembershipOrgIds: async () => orgIds,
  requireOrgId: async () => "id-a",
  filterAuthorizedOrgs: (orgs: Array<{ id: string }>, ids: ReadonlyMap<string, string>) =>
    orgs.filter((org) => ids.has(org.id))
}));

const listOrgs = vi.hoisted(() => vi.fn());
const listWorldModels = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ listOrgs, listWorldModels })
}));

// The org-access gate and switcher tag (E2) are their own units; both pass
// through here so this suite stays about fetch-count sharing.
vi.mock("@/lib/auth/org-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/org-access")>(
    "@/lib/auth/org-access"
  );
  return {
    ...actual,
    requireOrgAccess: async (identifier: string) => ({ orgId: identifier, orgSlug: identifier }),
    tagSsoRequiredOrgs: async <T>(orgs: readonly T[]) => [...orgs]
  };
});

import { resolveActiveOrg } from "@/lib/active-org";
import { loadOrgShell } from "@/lib/data-cache";

describe("the workspace org list within one render", () => {
  beforeEach(() => {
    listOrgs.mockReset();
    listWorldModels.mockReset();
    listOrgs.mockResolvedValue(ORGS);
    listWorldModels.mockResolvedValue([]);
  });

  it("is fetched once for the page and the sidebar together", async () => {
    // Every workspace page renders both: the layout resolves the active org and
    // the sidebar loads the shell packet. resolveActiveOrg used to call
    // getDataSource().listOrgs() directly, and a different function identity
    // defeats the request memo, so the backend served the same org list twice
    // per page. Both now read through listOrgsCached.
    const org = await resolveActiveOrg();
    const shell = await loadOrgShell(org.id);

    expect(shell.currentOrg).toEqual(org);
    expect(listOrgs).toHaveBeenCalledTimes(1);
  });
});
