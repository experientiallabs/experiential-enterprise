import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireOrg = vi.hoisted(() => vi.fn());
const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/server", () => ({
  requireAuthenticatedUser,
  AuthRequiredError: class AuthRequiredError extends Error {}
}));
vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/data-cache", () => ({ requireOrg }));

import { GET, PATCH } from "@/app/api/orgs/[orgId]/auto-recharge/route";

type Captured = { table: string; op: string; payload?: Record<string, unknown> };

function fakeAdmin(options: { row?: Record<string, unknown> | null; writeRow?: Record<string, unknown> }) {
  const captured: Captured[] = [];
  createServiceRoleSupabaseClient.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: options.row ?? null, error: null })
        })
      }),
      upsert: (payload: Record<string, unknown>) => {
        captured.push({ table, op: "upsert", payload });
        return {
          select: () => ({
            maybeSingle: async () => ({ data: options.writeRow ?? payload, error: null })
          })
        };
      }
    })
  });
  return captured;
}

function context(orgId = "org-1") {
  return { params: Promise.resolve({ orgId }) };
}

function request(body?: unknown): Request {
  return new Request("https://platform.example/api/orgs/org-1/auto-recharge", {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrg.mockResolvedValue({ id: "org-1", name: "Acme" });
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/orgs/[orgId]/auto-recharge", () => {
  it("returns the defaults with no card for an org that never opted in", async () => {
    fakeAdmin({ row: null });

    const response = await GET(request() as never, context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      thresholdUsd: 10,
      amountUsd: 5,
      hasPaymentMethod: false,
      lastRechargeAt: null,
      consecutiveFailures: 0,
      lastFailureMessage: null
    });
  });

  it("sanitizes the row: a saved card surfaces as hasPaymentMethod, never the id", async () => {
    fakeAdmin({
      row: {
        enabled: true,
        threshold_usd: 15,
        amount_usd: 25,
        stripe_payment_method_id: "pm_secret",
        last_recharge_at: "2026-08-20T00:00:00Z",
        consecutive_failures: 0,
        last_failure_message: null
      }
    });

    const response = await GET(request() as never, context());

    const payload = await response.json();
    expect(payload).toMatchObject({ hasPaymentMethod: true, thresholdUsd: 15, amountUsd: 25 });
    expect(JSON.stringify(payload)).not.toContain("pm_secret");
  });

  it("404s a non-admin member", async () => {
    isOrgAdmin.mockResolvedValue(false);
    fakeAdmin({ row: null });

    const response = await GET(request() as never, context());

    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/orgs/[orgId]/auto-recharge", () => {
  it("saves amount + threshold and clears the decline back-off", async () => {
    const captured = fakeAdmin({
      writeRow: {
        enabled: true,
        threshold_usd: 20,
        amount_usd: 25,
        stripe_payment_method_id: "pm_1",
        last_recharge_at: null,
        consecutive_failures: 0,
        last_failure_message: null
      }
    });

    const response = await PATCH(request({ amount_usd: 25, threshold_usd: 20 }) as never, context());

    expect(response.status).toBe(200);
    const upsert = captured.find((entry) => entry.op === "upsert");
    expect(upsert?.payload).toMatchObject({
      org_id: "org-1",
      amount_usd: 25,
      threshold_usd: 20,
      consecutive_failures: 0,
      last_failure_at: null,
      last_failure_message: null
    });
  });

  it("rejects an amount below the top-up floor", async () => {
    fakeAdmin({});

    const response = await PATCH(request({ amount_usd: 1 }) as never, context());

    expect(response.status).toBe(400);
  });

  it("accepts a $0 threshold (recharge only at empty) but rejects a non-boolean enabled", async () => {
    fakeAdmin({ writeRow: { enabled: true, threshold_usd: 0, amount_usd: 5 } });
    const zero = await PATCH(request({ threshold_usd: 0 }) as never, context());
    expect(zero.status).toBe(200);

    fakeAdmin({});
    const bad = await PATCH(request({ enabled: "yes" }) as never, context());
    expect(bad.status).toBe(400);
  });

  it("404s a non-admin member trying to write", async () => {
    isOrgAdmin.mockResolvedValue(false);
    fakeAdmin({});

    const response = await PATCH(request({ enabled: false }) as never, context());

    expect(response.status).toBe(404);
  });
});
