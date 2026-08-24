import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const requireAuthorizedOrgIds = vi.hoisted(() => vi.fn());
const resolveActiveOrg = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/server")>("@/lib/auth/server");
  return { ...actual, createServerSupabaseClient, requireAuthenticatedUser };
});
vi.mock("@/lib/auth/orgs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/orgs")>("@/lib/auth/orgs");
  return { ...actual, requireAuthorizedOrgIds };
});
vi.mock("@/lib/active-org", () => ({ resolveActiveOrg }));

import { POST } from "@/app/api/account/credit-welcome/route";

type LedgerRow = { entry_type: string; amount_usd: number; source_ref: string | null };

/**
 * Client double: `credit_ledger` select chain resolves the seeded rows, the
 * `user_credit_welcome` insert resolves `insertResult`.
 */
function supabaseClient(
  ledger: { data: LedgerRow[] | null; error: { message: string } | null },
  insertResult: { error: { code?: string; message: string } | null } = { error: null }
) {
  const insert = vi.fn().mockResolvedValue(insertResult);
  const in_ = vi.fn().mockResolvedValue(ledger);
  const eq = vi.fn().mockReturnValue({ in: in_ });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn((table: string) =>
    table === "credit_ledger" ? { select } : { insert }
  );
  return { from, insert, select, eq, in: in_ };
}

// The seeded YC demo org's launch rows: welcome promo, YC grant, the promo
// fold, and an (excluded) expiry clawback. Its $250 of Stripe top-ups never
// enter the query's source filter — announcing the cumulative counter instead
// of this event amount is exactly the "$776 in credits added" bug.
const YC_LEDGER: LedgerRow[] = [
  { entry_type: "grant", amount_usd: 20, source_ref: null },
  { entry_type: "grant", amount_usd: 526, source_ref: "org-1" },
  { entry_type: "adjustment", amount_usd: -20, source_ref: "promo-reversal:org-1" },
  { entry_type: "adjustment", amount_usd: -500, source_ref: "expiry:org-1" }
];

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireAuthorizedOrgIds.mockResolvedValue(new Set(["org-1"]));
  resolveActiveOrg.mockResolvedValue({ id: "org-1", slug: "org-1" });
});

describe("POST /api/account/credit-welcome", () => {
  it("wins the claim and reports the YC grant-event amount, not the cumulative total", async () => {
    const client = supabaseClient({ data: YC_LEDGER, error: null });
    createServerSupabaseClient.mockResolvedValue(client);

    const response = await POST();

    expect(response.status).toBe(200);
    // 20 + 526 - 20 (fold): the expiry clawback and top-ups never count.
    expect(await response.json()).toEqual({ firstView: true, welcomeGrantUsd: 526 });
    expect(client.eq).toHaveBeenCalledWith("org_id", "org-1");
    expect(client.in).toHaveBeenCalledWith("source", ["signup_promo", "yc_launch"]);
    expect(client.insert).toHaveBeenCalledWith({ user_id: "user-1" });
  });

  it("reports the standard $20 welcome grant for a non-YC org", async () => {
    const client = supabaseClient({
      data: [{ entry_type: "grant", amount_usd: 20, source_ref: null }],
      error: null
    });
    createServerSupabaseClient.mockResolvedValue(client);

    expect(await (await POST()).json()).toEqual({ firstView: true, welcomeGrantUsd: 20 });
  });

  it("reports not-first-view when the row already exists (a later visit)", async () => {
    const client = supabaseClient(
      { data: YC_LEDGER, error: null },
      { error: { code: "23505", message: "duplicate key" } }
    );
    createServerSupabaseClient.mockResolvedValue(client);

    expect(await (await POST()).json()).toEqual({ firstView: false, welcomeGrantUsd: 526 });
  });

  it("refuses to spend the claim when no launch grant exists yet", async () => {
    const client = supabaseClient({ data: [], error: null });
    createServerSupabaseClient.mockResolvedValue(client);

    expect(await (await POST()).json()).toEqual({ firstView: false, welcomeGrantUsd: null });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it("refuses to spend the claim when the ledger read fails", async () => {
    const client = supabaseClient({ data: null, error: { message: "boom" } });
    createServerSupabaseClient.mockResolvedValue(client);

    expect(await (await POST()).json()).toEqual({ firstView: false, welcomeGrantUsd: null });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it("degrades silently for a memberless session without resolving an org", async () => {
    requireAuthorizedOrgIds.mockResolvedValue(new Set());

    expect(await (await POST()).json()).toEqual({ firstView: false, welcomeGrantUsd: null });
    expect(resolveActiveOrg).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected insert failure as a 500", async () => {
    const client = supabaseClient(
      { data: YC_LEDGER, error: null },
      { error: { code: "42501", message: "denied" } }
    );
    createServerSupabaseClient.mockResolvedValue(client);

    const response = await POST();

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("denied");
  });

  it("401s an unauthenticated caller through jsonError", async () => {
    const { AuthRequiredError } = await vi.importActual<typeof import("@/lib/auth/server")>(
      "@/lib/auth/server"
    );
    requireAuthenticatedUser.mockRejectedValue(new AuthRequiredError());

    expect((await POST()).status).toBe(401);
  });
});
