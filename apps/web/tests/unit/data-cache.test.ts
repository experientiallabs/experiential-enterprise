import { beforeEach, describe, expect, it, vi } from "vitest";

const listOrgs = vi.fn();
const listWorldModels = vi.fn();
const listMembershipOrgIds = vi.hoisted(() => vi.fn());

vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ listOrgs, listWorldModels })
}));

vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, listMembershipOrgIds };
});

// The switcher tag enrichment (E2) is its own unit; here it passes through
// so the shell assertions stay about membership filtering.
vi.mock("@/lib/auth/org-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/org-access")>(
    "@/lib/auth/org-access"
  );
  return { ...actual, tagSsoRequiredOrgs: async <T>(orgs: readonly T[]) => [...orgs] };
});

import { DataSourceNotFoundError } from "@/lib/errors";
import { loadOrgShell } from "@/lib/data-cache";
import { makeOrg } from "./fixtures";

const demo = makeOrg({ id: "org1", slug: "demo", name: "Demo" });
const hidden = makeOrg({ id: "org2", slug: "hidden", name: "Hidden" });

describe("loadOrgShell", () => {
  beforeEach(() => {
    listOrgs.mockReset();
    listWorldModels.mockReset();
    listMembershipOrgIds.mockReset();
    listOrgs.mockResolvedValue([demo, hidden]);
    listWorldModels.mockResolvedValue([]);
    listMembershipOrgIds.mockResolvedValue(new Map([["org1", "org1"]]));
  });

  it("lists only the caller's own memberships without fetching world models", async () => {
    const shell = await loadOrgShell("org1");

    expect(shell.orgs.map((org) => org.id)).toEqual(["org1"]);
    expect(shell.currentOrg).toEqual(demo);
    expect(listWorldModels).not.toHaveBeenCalled();
  });

  it("hides a memberless template org from a platform admin's switcher while still resolving it as the active org", async () => {
    // A platform admin belongs only to `demo`; the memberless template org
    // (demo-examples) is reachable by URL via the select-all bypass but must not
    // clutter the switcher. loadOrgShell filters the switcher by membership, so
    // opening the template org keeps it as currentOrg without adding it to the list.
    const template = makeOrg({ id: "org2", slug: "demo-examples", name: "Demo Examples" });
    listOrgs.mockResolvedValue([demo, template]);
    listMembershipOrgIds.mockResolvedValue(new Map([["org1", "org1"]]));

    const shell = await loadOrgShell("org2");

    expect(shell.currentOrg).toEqual(template);
    expect(shell.orgs.map((org) => org.id)).toEqual(["org1"]);
  });

  it("resolves the active org by slug so slug URLs share the shell", async () => {
    const shell = await loadOrgShell("demo");

    expect(shell.currentOrg).toEqual(demo);
    expect(listWorldModels).not.toHaveBeenCalled();
  });

  it("propagates a missing org so the caller can render a 404", async () => {
    await expect(loadOrgShell("org-unknown")).rejects.toBeInstanceOf(DataSourceNotFoundError);
  });
});
