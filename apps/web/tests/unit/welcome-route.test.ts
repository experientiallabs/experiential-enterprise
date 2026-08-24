import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const requireAuthorizedOrgIds = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const getOrgBudget = vi.hoisted(() => vi.fn());
const readLaunchGrantUsd = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return { ...actual, createServerSupabaseClient, requireAuthenticatedUser };
});
vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, requireAuthorizedOrgIds };
});
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));
vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/data-source", () => ({ getDataSource: () => ({ getOrgBudget }) }));
vi.mock("@/lib/billing/launch-grant", () => ({ readLaunchGrantUsd }));

import { GET } from "@/app/api/welcome/route";

/** Chainable api_keys read that resolves to `result` at `.limit()`. */
function supabaseWithKeys(result: { data: unknown; error: { message: string } | null }) {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue(result)
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.is.mockReturnValue(chain);
  chain.or.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  return { from: vi.fn().mockReturnValue(chain), chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireAuthorizedOrgIds.mockResolvedValue(new Set(["org-1"]));
  resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "acme" });
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
  getOrgBudget.mockResolvedValue({
    spend_usd: 0,
    billable_spend_usd: 0,
    credit_granted_usd: 20,
    credit_balance_usd: 20
  });
  readLaunchGrantUsd.mockResolvedValue(20);
});

describe("GET /api/welcome", () => {
  it("returns the active org, its newest active key prefix, and the grant", async () => {
    const { from } = supabaseWithKeys({
      data: [{ key_prefix: "xpl_ab12cd34", key_suffix: "f2e1" }],
      error: null
    });
    createServerSupabaseClient.mockResolvedValue({ from });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      org: { id: "org-1", slug: "acme" },
      apiKey: { keyPrefix: "xpl_ab12cd34", keySuffix: "f2e1" },
      canManageKeys: true,
      credit: { grantedUsd: 20, billableUsd: 0 }
    });
    expect(getOrgBudget).toHaveBeenCalledWith("org-1");
    expect(readLaunchGrantUsd).toHaveBeenCalledWith(expect.anything(), "org-1");
  });

  it("announces the launch-grant EVENT amount, never the cumulative counter", async () => {
    // A seeded org: $526 YC grant plus $250 of Stripe top-ups. The counter says
    // $776; the celebration must say $526 (PR #685's rule, shared here).
    getOrgBudget.mockResolvedValue({
      spend_usd: 0,
      billable_spend_usd: 0,
      credit_granted_usd: 776,
      credit_balance_usd: 776
    });
    readLaunchGrantUsd.mockResolvedValue(526);
    const { from } = supabaseWithKeys({ data: [], error: null });
    createServerSupabaseClient.mockResolvedValue({ from });

    const payload = await (await GET()).json();

    expect(payload.credit).toEqual({ grantedUsd: 526, billableUsd: 0 });
  });

  it("degrades an unreadable ledger to a zero grant, not the counter", async () => {
    readLaunchGrantUsd.mockResolvedValue(null);
    const { from } = supabaseWithKeys({ data: [], error: null });
    createServerSupabaseClient.mockResolvedValue({ from });

    const payload = await (await GET()).json();

    expect(payload.credit.grantedUsd).toBe(0);
  });

  it("reports a keyless org as mintable for an org admin", async () => {
    const { from } = supabaseWithKeys({ data: [], error: null });
    createServerSupabaseClient.mockResolvedValue({ from });

    const payload = await (await GET()).json();

    expect(payload.apiKey).toBeNull();
    expect(payload.canManageKeys).toBe(true);
  });

  it("marks a plain member unable to mint", async () => {
    isOrgAdmin.mockResolvedValue(false);
    const { from } = supabaseWithKeys({ data: [], error: null });
    createServerSupabaseClient.mockResolvedValue({ from });

    const payload = await (await GET()).json();

    expect(payload.canManageKeys).toBe(false);
  });

  it("reads through the service role for platform admins", async () => {
    isPlatformAdmin.mockResolvedValue(true);
    const { from } = supabaseWithKeys({ data: [], error: null });
    createServiceRoleSupabaseClient.mockReturnValue({ from });

    const payload = await (await GET()).json();

    expect(payload.canManageKeys).toBe(true);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith("api_keys");
  });

  it("answers a memberless session with JSON, not the /orgs redirect", async () => {
    requireAuthorizedOrgIds.mockResolvedValue(new Set());

    const response = await GET();

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("no_org");
    expect(resolveActiveOrg).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller through jsonError", async () => {
    const { AuthRequiredError } = await vi.importActual<typeof import("@/lib/auth/server")>(
      "@/lib/auth/server"
    );
    requireAuthenticatedUser.mockRejectedValue(new AuthRequiredError());

    expect((await GET()).status).toBe(401);
  });
});
