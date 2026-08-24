import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const isPlatformAdmin = vi.hoisted(() => vi.fn());
const isOrgAdmin = vi.hoisted(() => vi.fn());
const requireAuthenticatedUser = vi.hoisted(() => vi.fn());
const requireOrg = vi.hoisted(() => vi.fn());
const sessionsCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient, isPlatformAdmin }));
vi.mock("@/lib/auth/admin-orgs", () => ({ isOrgAdmin }));
vi.mock("@/lib/auth/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireAuthenticatedUser };
});
vi.mock("@/lib/data-cache", () => ({ requireOrg }));
vi.mock("@/lib/billing/stripe", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/billing/stripe")>("@/lib/billing/stripe");
  return {
    ...actual,
    stripeClient: () => ({ checkout: { sessions: { create: sessionsCreate } } })
  };
});

import { POST } from "@/app/api/orgs/[orgId]/billing/checkout/route";
import {
  MAX_TOPUP_USD,
  MIN_TOPUP_USD,
  TOPUP_PRESETS_USD
} from "@/lib/billing/constants";

const context = { params: Promise.resolve({ orgId: "org-1" }) };

function post(body: unknown): Request {
  return new Request("https://platform.example/api/orgs/org-1/billing/checkout", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthenticatedUser.mockResolvedValue({ id: "user-1" });
  requireOrg.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
  isPlatformAdmin.mockResolvedValue(false);
  isOrgAdmin.mockResolvedValue(true);
  sessionsCreate.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/orgs/[orgId]/billing/checkout", () => {
  it("hides billing from non-admin members", async () => {
    isOrgAdmin.mockResolvedValue(false);

    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(404);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("refuses amounts outside the bounds and non-cent amounts", async () => {
    expect((await POST(post({ amount_usd: 4.99 }) as never, context)).status).toBe(400);
    expect((await POST(post({ amount_usd: MAX_TOPUP_USD + 1 }) as never, context)).status).toBe(
      400
    );
    expect((await POST(post({ amount_usd: 10.001 }) as never, context)).status).toBe(400);
    expect((await POST(post({ amount_usd: "25" }) as never, context)).status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("accepts every preset and both bounds", async () => {
    expect(TOPUP_PRESETS_USD).toEqual([25, 100, 500]);
    for (const amount of [...TOPUP_PRESETS_USD, MIN_TOPUP_USD, MAX_TOPUP_USD]) {
      const response = await POST(post({ amount_usd: amount }) as never, context);
      expect(response.status).toBe(200);
    }
    const chargedCents = sessionsCreate.mock.calls.map(
      ([params]) => params.line_items[0].price_data.unit_amount
    );
    expect(chargedCents).toEqual([2500, 10000, 50000, 500, 1_000_000]);
  });

  it("creates a card-only one-time session carrying the org attribution", async () => {
    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_1"
    });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.mode).toBe("payment");
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.client_reference_id).toBe("org-1");
    expect(params.metadata).toEqual({
      purpose: "platform-credit-topup",
      org_id: "org-1",
      requested_by: "user-1",
      autorecharge: "off"
    });
    // No consent: a plain one-time top-up saves no card.
    expect(params.customer_creation).toBeUndefined();
    expect(params.payment_intent_data).toBeUndefined();
    expect(params.line_items[0].price_data.unit_amount).toBe(2500);
    expect(params.line_items[0].price_data.currency).toBe("usd");
    expect(params.success_url).toContain("/credits?topup=success");
    expect(params.cancel_url).toContain("/credits?topup=cancelled");
  });

  it("saves the card off-session and carries the auto-recharge config when consented", async () => {
    const response = await POST(
      post({
        amount_usd: 25,
        auto_recharge: { enabled: true, amount_usd: 5, threshold_usd: 10 }
      }) as never,
      context
    );

    expect(response.status).toBe(200);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.customer_creation).toBe("always");
    expect(params.payment_intent_data).toEqual({ setup_future_usage: "off_session" });
    expect(params.metadata).toEqual({
      purpose: "platform-credit-topup",
      org_id: "org-1",
      requested_by: "user-1",
      autorecharge: "on",
      autorecharge_threshold_usd: "10",
      autorecharge_amount_usd: "5"
    });
  });

  it("rejects a consented auto-recharge amount below the top-up floor", async () => {
    const response = await POST(
      post({ amount_usd: 25, auto_recharge: { enabled: true, amount_usd: 1 } }) as never,
      context
    );

    expect(response.status).toBe(400);
  });

  it("anchors the return URLs to the configured public origin, not the Host header", async () => {
    vi.stubEnv("EXPLABS_WEBAPP_URL", "https://platform.experientiallabs.ai");

    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(200);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.success_url).toBe(
      "https://platform.experientiallabs.ai/credits?topup=success"
    );
    expect(params.cancel_url).toBe(
      "https://platform.experientiallabs.ai/credits?topup=cancelled"
    );
  });

  it("keeps Stripe's error detail server-side and answers 502", async () => {
    sessionsCreate.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such price"
      } as never)
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "The payment provider refused the request."
    });
    consoleError.mockRestore();
  });

  it("anchors the return URLs to the configured public origin, not the Host header", async () => {
    vi.stubEnv("EXPLABS_WEBAPP_URL", "https://platform.experientiallabs.ai");

    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(200);
    const params = sessionsCreate.mock.calls[0][0];
    expect(params.success_url).toBe(
      "https://platform.experientiallabs.ai/credits?topup=success"
    );
    expect(params.cancel_url).toBe(
      "https://platform.experientiallabs.ai/credits?topup=cancelled"
    );
  });

  it("keeps Stripe's error detail server-side and answers 502", async () => {
    sessionsCreate.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        message: "No such price"
      } as never)
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "The payment provider refused the request."
    });
    consoleError.mockRestore();
  });

  it("surfaces a missing checkout URL as an upstream failure, not a silent success", async () => {
    sessionsCreate.mockResolvedValue({ url: null });

    const response = await POST(post({ amount_usd: 25 }) as never, context);

    expect(response.status).toBe(502);
  });
});
