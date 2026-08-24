import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const sendRechargeEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/billing/recharge-email", () => ({ sendRechargeEmail }));

import { POST } from "@/app/api/stripe/webhook/route";

const WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests";

function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi_autorecharge_1",
    object: "payment_intent",
    currency: "usd",
    amount: 500,
    amount_received: 500,
    metadata: { purpose: "platform-credit-autorecharge", org_id: "org-1", attempt_id: "attempt-1" },
    ...overrides
  };
}

function eventPayload(type: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: "evt_test_1",
    object: "event",
    api_version: "2026-06-30",
    livemode: false,
    type,
    data: { object }
  });
}

async function signedRequest(payload: string): Promise<Request> {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return new Request("https://platform.example/api/stripe/webhook", {
    body: payload,
    headers: { "stripe-signature": signature },
    method: "POST"
  });
}

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeAdmin(options: { rpcResult?: { data: unknown; error: unknown }; notifyEmail?: string | null }) {
  const rpcCalls: RpcCall[] = [];
  createServiceRoleSupabaseClient.mockReturnValue({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(options.rpcResult ?? { data: "credited", error: null });
    },
    from: (table: string) => {
      if (table === "org_auto_recharge_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { notify_email: options.notifyEmail ?? "owner@example.com" },
                error: null
              })
            })
          })
        };
      }
      // organizations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { name: "Acme", credit_granted_usd: 30, billable_spend_usd: 20 },
              error: null
            })
          })
        })
      };
    }
  });
  return rpcCalls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  sendRechargeEmail.mockResolvedValue({ sent: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/stripe/webhook — off-session auto-recharge", () => {
  it("credits and emails on payment_intent.succeeded carrying the auto-recharge marker", async () => {
    const rpcCalls = fakeAdmin({ rpcResult: { data: "credited", error: null } });
    const request = await signedRequest(eventPayload("payment_intent.succeeded", paymentIntent()));

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true });
    expect(rpcCalls).toEqual([
      {
        name: "record_auto_recharge_success",
        args: {
          in_org: "org-1",
          in_payment_intent_id: "pi_autorecharge_1",
          in_amount_usd: 5,
          in_created_by: "auto-recharge"
        }
      }
    ]);
    expect(sendRechargeEmail).toHaveBeenCalledTimes(1);
    expect(sendRechargeEmail.mock.calls[0][0]).toMatchObject({
      to: "owner@example.com",
      orgName: "Acme",
      amountUsd: 5,
      newBalanceUsd: 10
    });
  });

  it("treats a replayed recharge as converged and does not re-email", async () => {
    fakeAdmin({ rpcResult: { data: "replay", error: null } });
    const request = await signedRequest(eventPayload("payment_intent.succeeded", paymentIntent()));

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true, replay: true });
    expect(sendRechargeEmail).not.toHaveBeenCalled();
  });

  it("ignores a normal top-up's payment_intent.succeeded (no auto-recharge marker)", async () => {
    const rpcCalls = fakeAdmin({});
    const request = await signedRequest(
      eventPayload("payment_intent.succeeded", paymentIntent({ metadata: { org_id: "org-1" } }))
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: false });
    expect(rpcCalls).toEqual([]);
    expect(sendRechargeEmail).not.toHaveBeenCalled();
  });

  it("records a failure on payment_intent.payment_failed for an auto-recharge", async () => {
    const rpcCalls = fakeAdmin({});
    const request = await signedRequest(
      eventPayload(
        "payment_intent.payment_failed",
        paymentIntent({ last_payment_error: { message: "Your card was declined." } })
      )
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true });
    expect(rpcCalls).toEqual([
      {
        name: "record_auto_recharge_failure",
        args: {
          in_org: "org-1",
          in_payment_intent_id: "pi_autorecharge_1",
          in_message: "Your card was declined."
        }
      }
    ]);
  });

  it("returns 500 so Stripe retries when the success RPC fails", async () => {
    fakeAdmin({ rpcResult: { data: null, error: { message: "db down" } } });
    const request = await signedRequest(eventPayload("payment_intent.succeeded", paymentIntent()));

    const response = await POST(request as never);

    expect(response.status).toBe(500);
    expect(sendRechargeEmail).not.toHaveBeenCalled();
  });
});
