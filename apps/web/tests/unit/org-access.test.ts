import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const listAuthorizedOrgIds = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return { ...actual, createServerSupabaseClient, requireAuthenticatedUser };
});
vi.mock("@/lib/auth/orgs", () => ({ listAuthorizedOrgIds }));
vi.mock("@/lib/auth/admin", () => ({ isPlatformAdmin }));

import {
  resetSsoRequiredCacheForTests,
  requireOrgAccess,
  SsoStepUpRequiredError,
  tagSsoRequiredOrgs
} from "@/lib/auth/org-access";
import { DataSourceNotFoundError, DataSourceRequestError } from "@/lib/errors";
import { jsonError } from "@/lib/http";
import type { Org } from "@/lib/types";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

type AmrEntry = { method: string; timestamp: number };

/**
 * A supabase stub covering the three reads the gate makes: the
 * org_sso_required RPC, the membership-role point read, and the session's
 * verified claims (AMR).
 */
function supabaseStub({
  ssoRequired,
  role,
  amr
}: {
  ssoRequired: boolean;
  role: "admin" | "user" | null;
  amr: AmrEntry[] | undefined;
}) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: role === null ? null : { role },
      error: null
    })
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return {
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === "org_sso_required") {
        return Promise.resolve({ data: ssoRequired, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    }),
    from: vi.fn().mockReturnValue(chain),
    auth: {
      getClaims: vi.fn().mockResolvedValue({ data: { claims: { sub: "user-1", amr } }, error: null })
    }
  };
}

beforeEach(() => {
  resetSsoRequiredCacheForTests();
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1", email: null });
  isPlatformAdmin.mockResolvedValue(false);
  listAuthorizedOrgIds.mockResolvedValue(
    new Map([
      ["acme", ORG_ID],
      [ORG_ID, ORG_ID]
    ])
  );
});

describe("requireOrgAccess", () => {
  it("resolves a slug to the canonical id when the org does not require SSO", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({ ssoRequired: false, role: "user", amr: undefined })
    );
    await expect(requireOrgAccess("acme")).resolves.toEqual({ orgId: ORG_ID, orgSlug: "acme" });
  });

  it("keeps the resource 404 for non-members, even for an SSO org", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({ ssoRequired: true, role: null, amr: undefined })
    );
    // A non-member must never receive the step-up signal — it would confirm
    // the org exists and requires SSO.
    await expect(requireOrgAccess("other-org")).rejects.toBeInstanceOf(DataSourceNotFoundError);
  });

  it("throws the step-up signal for a member session whose method is not the IdP", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({
        ssoRequired: true,
        role: "user",
        amr: [{ method: "password", timestamp: 100 }]
      })
    );
    const failure = await requireOrgAccess("acme").catch((error) => error);
    expect(failure).toBeInstanceOf(SsoStepUpRequiredError);
    expect((failure as SsoStepUpRequiredError).orgSlug).toBe("acme");
    expect((failure as SsoStepUpRequiredError).orgId).toBe(ORG_ID);
  });

  it("admits a session whose LATEST method is sso/saml over an older password entry", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({
        ssoRequired: true,
        role: "user",
        amr: [
          { method: "password", timestamp: 100 },
          { method: "sso/saml", timestamp: 200 }
        ]
      })
    );
    await expect(requireOrgAccess("acme")).resolves.toEqual({ orgId: ORG_ID, orgSlug: "acme" });
  });

  it("refuses a session that stepped DOWN after SSO (newest entry wins)", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({
        ssoRequired: true,
        role: "user",
        amr: [
          { method: "sso/saml", timestamp: 100 },
          { method: "password", timestamp: 200 }
        ]
      })
    );
    await expect(requireOrgAccess("acme")).rejects.toBeInstanceOf(SsoStepUpRequiredError);
  });

  it("lets platform admins pass the SSO gate (operators pass every org check)", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({ ssoRequired: true, role: null, amr: [{ method: "password", timestamp: 1 }] })
    );
    await expect(requireOrgAccess("acme")).resolves.toEqual({ orgId: ORG_ID, orgSlug: "acme" });
  });

  it("enforces the admin minimum before the SSO gate", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({
        ssoRequired: true,
        role: "user",
        amr: [{ method: "password", timestamp: 100 }]
      })
    );
    // A plain member asking for admin strength fails on ROLE (403), never
    // reaching the step-up signal: membership strength is decided first.
    const failure = await requireOrgAccess("acme", { minimumRole: "admin" }).catch(
      (error) => error
    );
    expect(failure).toBeInstanceOf(DataSourceRequestError);
    expect((failure as DataSourceRequestError).status).toBe(403);
  });

  it("gates an admin-strength caller on SSO after the role passes", async () => {
    createServerSupabaseClient.mockResolvedValue(
      supabaseStub({
        ssoRequired: true,
        role: "admin",
        amr: [{ method: "password", timestamp: 100 }]
      })
    );
    await expect(requireOrgAccess("acme", { minimumRole: "admin" })).rejects.toBeInstanceOf(
      SsoStepUpRequiredError
    );
  });
});

describe("jsonError", () => {
  it("surfaces the step-up signal as 403 sso_required for org-scoped API routes", async () => {
    const response = jsonError(new SsoStepUpRequiredError(ORG_ID, "acme"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "sso_required", org: "acme" });
  });
});

describe("tagSsoRequiredOrgs", () => {
  it("tags exactly the orgs the definer read names", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [ORG_ID], error: null });
    createServerSupabaseClient.mockResolvedValue({ rpc });
    const orgs = [
      { id: ORG_ID, slug: "acme", name: "Acme" },
      { id: "22222222-2222-2222-2222-222222222222", slug: "beta", name: "Beta" }
    ] as Org[];
    const tagged = await tagSsoRequiredOrgs(orgs);
    expect(tagged.map((org) => org.sso_required)).toEqual([true, false]);
    expect(rpc).toHaveBeenCalledWith("sso_required_org_ids", {
      in_org_ids: [ORG_ID, "22222222-2222-2222-2222-222222222222"]
    });
  });

  it("passes an empty list through without a read", async () => {
    await expect(tagSsoRequiredOrgs([])).resolves.toEqual([]);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });
});
