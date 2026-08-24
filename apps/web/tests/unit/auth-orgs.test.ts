import { describe, expect, it } from "vitest";

import { filterAuthorizedOrgs } from "@/lib/auth/orgs";
import type { Org } from "@/lib/types";

import { makeOrg } from "./fixtures";

const orgs: Org[] = [
  makeOrg({
    id: "00000000-0000-0000-0000-000000000002",
    slug: "demo",
    name: "Demo"
  }),
  makeOrg({
    id: "00000000-0000-0000-0000-000000000202",
    slug: "second",
    name: "Second Workspace"
  })
];

describe("filterAuthorizedOrgs", () => {
  it("keeps organizations matched by database id", () => {
    const authorizedOrgs = filterAuthorizedOrgs(
      orgs,
      new Map([
        ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000002"],
        ["00000000-0000-0000-0000-000000000202", "00000000-0000-0000-0000-000000000202"]
      ])
    );

    expect(authorizedOrgs.map((org) => org.slug)).toEqual(["demo", "second"]);
  });

  it("drops organizations that are not visible to the authenticated user", () => {
    const authorizedOrgs = filterAuthorizedOrgs(
      orgs,
      new Map([
        ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000002"]
      ])
    );

    expect(authorizedOrgs.map((org) => org.slug)).toEqual(["demo"]);
  });

  it("filters by id even though the map is also keyed by slug for URL gating", () => {
    // listAuthorizedOrgIds is keyed by both id and slug so requireOrgId can gate
    // slug URLs, but org-list filtering stays strictly id-based.
    const authorizedOrgs = filterAuthorizedOrgs(
      orgs,
      new Map([["demo", "00000000-0000-0000-0000-000000000002"]])
    );

    expect(authorizedOrgs).toEqual([]);
  });
});
