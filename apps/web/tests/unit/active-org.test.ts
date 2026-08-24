import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveActiveOrg is request-cached via React cache(); outside a request
// scope that would memoize across test cases, so neutralize it here.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn
}));

const cookieStore = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "explabs-active-org" && cookieStore.value !== null
        ? { name, value: cookieStore.value }
        : undefined
  })
}));

const redirect = vi.hoisted(() =>
  vi.fn((destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  })
);
vi.mock("next/navigation", () => ({ redirect }));

const ORGS = [
  { id: "id-a", slug: "acme", name: "Acme" },
  { id: "id-b", slug: "beta", name: "Beta" }
];

/** The real map shape: every id and slug the caller may use, keyed to the id. */
function orgIdMap(...ids: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const org of ORGS) {
    if (ids.includes(org.id)) {
      entries.set(org.id, org.id);
      entries.set(org.slug, org.id);
    }
  }
  return entries;
}

const authorizedIds = vi.hoisted(() => ({ value: new Map<string, string>() }));
const membershipIds = vi.hoisted(() => ({ value: new Map<string, string>() }));
vi.mock("@/lib/auth/orgs", () => ({
  requireAuthorizedOrgIds: async () => authorizedIds.value,
  listMembershipOrgIds: async () => membershipIds.value,
  filterAuthorizedOrgs: (orgs: Array<{ id: string }>, ids: ReadonlyMap<string, string>) =>
    orgs.filter((org) => ids.has(org.id))
}));
const listOrgs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/data-source", () => ({
  getDataSource: () => ({ listOrgs })
}));

// The org-access gate itself is unit-tested in org-access.test.ts; here it is
// a controllable seam so this suite covers the resolution rules AND the
// step-up redirect without real supabase reads.
const requireOrgAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/org-access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/org-access")>(
    "@/lib/auth/org-access"
  );
  return { ...actual, requireOrgAccess };
});

import { SsoStepUpRequiredError } from "@/lib/auth/org-access";
import {
  findAuthorizedOrg,
  resolveActiveOrg,
  resolveActiveOrgForTelemetry
} from "@/lib/active-org";

beforeEach(() => {
  listOrgs.mockReset();
  listOrgs.mockResolvedValue(ORGS);
  requireOrgAccess.mockReset();
  requireOrgAccess.mockImplementation(async (identifier: string) => ({
    orgId: identifier,
    orgSlug: identifier
  }));
  authorizedIds.value = orgIdMap("id-a", "id-b");
  membershipIds.value = orgIdMap("id-a", "id-b");
  cookieStore.value = null;
});

describe("resolveActiveOrg", () => {
  it("honors a cookie naming an authorized org by slug or id", async () => {
    cookieStore.value = "beta";
    expect((await resolveActiveOrg()).slug).toBe("beta");
    cookieStore.value = "id-b";
    expect((await resolveActiveOrg()).slug).toBe("beta");
  });

  it("falls back to the first authorized org for a stale or missing cookie", async () => {
    cookieStore.value = "org-i-was-removed-from";
    expect((await resolveActiveOrg()).slug).toBe("acme");
    cookieStore.value = null;
    expect((await resolveActiveOrg()).slug).toBe("acme");
  });

  it("prefers a membership org over the admin bypass list for the default", async () => {
    // A platform admin is authorized for every org, but their fresh session
    // opens the workspace they belong to, not the publisher org that happens
    // to sort first in the bypass list.
    cookieStore.value = null;
    membershipIds.value = orgIdMap("id-b");
    expect((await resolveActiveOrg()).slug).toBe("beta");
  });

  it("keeps the bypass fallback for an admin with no memberships", async () => {
    cookieStore.value = null;
    membershipIds.value = orgIdMap();
    expect((await resolveActiveOrg()).slug).toBe("acme");
  });

  it("sends memberless sessions to the organizations page", async () => {
    authorizedIds.value = orgIdMap();
    await expect(resolveActiveOrg()).rejects.toThrow("NEXT_REDIRECT:/orgs");
  });

  it("redirects to step-up sign-in when the resolved org requires SSO (E2)", async () => {
    cookieStore.value = "acme";
    requireOrgAccess.mockRejectedValue(new SsoStepUpRequiredError("id-a", "acme"));
    await expect(resolveActiveOrg()).rejects.toThrow(
      "NEXT_REDIRECT:/signin?sso_required=acme"
    );
  });
});

describe("resolveActiveOrgForTelemetry", () => {
  it("resolves the same org the workspace gate would", async () => {
    cookieStore.value = "beta";
    expect((await resolveActiveOrgForTelemetry())?.slug).toBe("beta");
  });

  it("answers null instead of redirecting for a memberless session", async () => {
    authorizedIds.value = orgIdMap();
    expect(await resolveActiveOrgForTelemetry()).toBeNull();
  });

  it("answers null for a step-up-required org — analytics never redirects", async () => {
    requireOrgAccess.mockRejectedValue(new SsoStepUpRequiredError("id-a", "acme"));
    expect(await resolveActiveOrgForTelemetry()).toBeNull();
  });

  it("answers null when resolution throws — analytics never breaks a render", async () => {
    listOrgs.mockRejectedValue(new Error("backend unavailable"));
    expect(await resolveActiveOrgForTelemetry()).toBeNull();
  });

  it("re-throws Next control-flow errors instead of swallowing them", async () => {
    const redirectError = Object.assign(new Error("redirect"), {
      digest: "NEXT_REDIRECT;replace;/signin;307;"
    });
    listOrgs.mockRejectedValue(redirectError);
    await expect(resolveActiveOrgForTelemetry()).rejects.toBe(redirectError);
  });
});

describe("findAuthorizedOrg", () => {
  it("resolves only orgs the session may access", async () => {
    expect((await findAuthorizedOrg("acme"))?.id).toBe("id-a");
    expect((await findAuthorizedOrg("id-b"))?.slug).toBe("beta");
    expect(await findAuthorizedOrg("someone-elses-org")).toBeNull();
  });
});
