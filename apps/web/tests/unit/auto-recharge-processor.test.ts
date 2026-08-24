import { beforeEach, describe, expect, it, vi } from "vitest";

import { processPendingAutoRecharges } from "@/lib/billing/auto-recharge";

// A card decline as the Stripe SDK raises it off-session: a StripeCardError
// carrying the failed PaymentIntent. Duck-typed so the processor's detection
// does not depend on SDK class identity.
function cardError(message: string, intentId: string | null) {
  return {
    type: "StripeCardError",
    message,
    ...(intentId ? { payment_intent: { id: intentId } } : {})
  };
}

type Chain = { method: string; args: unknown[] };

type AdminOptions = {
  candidates: Record<string, unknown>[];
  settings: Record<string, unknown>[];
  claimReturnsEmpty?: boolean;
};

/**
 * A chainable, thenable Supabase stub: every builder method records itself and
 * returns the same proxy, and awaiting the chain resolves through one handler
 * that branches on the table and the recorded methods. Enough to drive the
 * processor's exact call shapes without a database.
 */
function makeAdmin(options: AdminOptions) {
  const updates: Record<string, unknown>[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  function resolve(table: string, chain: Chain[]) {
    const has = (method: string) => chain.some((entry) => entry.method === method);
    if (table === "auto_recharge_attempts") {
      if (has("or")) {
        return { data: options.candidates, error: null };
      }
      if (has("update") && has("select")) {
        return { data: options.claimReturnsEmpty ? [] : [{ id: "attempt" }], error: null };
      }
      if (has("update")) {
        const update = chain.find((entry) => entry.method === "update");
        updates.push((update?.args[0] ?? {}) as Record<string, unknown>);
        return { data: null, error: null };
      }
    }
    if (table === "org_auto_recharge_settings") {
      return { data: options.settings, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const chain: Chain[] = [];
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
              Promise.resolve(resolve(table, chain)).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            chain.push({ method: String(prop), args });
            return proxy;
          };
        }
      }
    );
    return proxy;
  }

  const admin = {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    }
  };
  return { admin: admin as never, updates, rpcCalls };
}

const NOW = new Date("2026-08-20T12:00:00Z");
const now = () => NOW;

function pendingAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "attempt-1",
    org_id: "org-1",
    amount_usd: 5,
    status: "pending",
    stripe_payment_intent_id: null,
    updated_at: "2026-08-20T11:59:00Z",
    ...overrides
  };
}

function savedCard(overrides: Record<string, unknown> = {}) {
  return {
    org_id: "org-1",
    stripe_customer_id: "cus_1",
    stripe_payment_method_id: "pm_1",
    ...overrides
  };
}

let create: ReturnType<typeof vi.fn>;

beforeEach(() => {
  create = vi.fn();
});

function stripeWith(create: ReturnType<typeof vi.fn>) {
  return { paymentIntents: { create } } as never;
}

describe("processPendingAutoRecharges", () => {
  it("creates exactly one off-session PaymentIntent for a queued attempt with a saved card", async () => {
    create.mockResolvedValue({ id: "pi_1", status: "succeeded" });
    const { admin, rpcCalls } = makeAdmin({
      candidates: [pendingAttempt()],
      settings: [savedCard()]
    });

    const summary = await processPendingAutoRecharges({ stripe: stripeWith(create), admin, now });

    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0];
    expect(params).toMatchObject({
      amount: 500,
      currency: "usd",
      customer: "cus_1",
      payment_method: "pm_1",
      off_session: true,
      confirm: true,
      metadata: {
        purpose: "platform-credit-autorecharge",
        org_id: "org-1",
        attempt_id: "attempt-1"
      }
    });
    // Idempotency keyed on the attempt id: a re-lease reuses the same charge.
    expect(options).toEqual({ idempotencyKey: "attempt-1" });
    expect(summary.charged).toBe(1);
    // Crediting is the webhook's job, never the poller's.
    expect(rpcCalls.filter((call) => call.name === "record_auto_recharge_success")).toHaveLength(0);
  });

  it("records a decline without looping (no second charge, failure recorded)", async () => {
    create.mockRejectedValue(cardError("Your card was declined.", "pi_declined"));
    const { admin, rpcCalls } = makeAdmin({
      candidates: [pendingAttempt()],
      settings: [savedCard()]
    });

    const summary = await processPendingAutoRecharges({ stripe: stripeWith(create), admin, now });

    expect(create).toHaveBeenCalledTimes(1);
    expect(summary.declined).toBe(1);
    expect(summary.charged).toBe(0);
    const failure = rpcCalls.find((call) => call.name === "record_auto_recharge_failure");
    expect(failure?.args).toMatchObject({
      in_org: "org-1",
      in_payment_intent_id: "pi_declined",
      in_message: "Your card was declined."
    });
  });

  it("treats a lost claim as a skip and never charges twice", async () => {
    create.mockResolvedValue({ id: "pi_1", status: "succeeded" });
    const { admin } = makeAdmin({
      candidates: [pendingAttempt()],
      settings: [savedCard()],
      claimReturnsEmpty: true
    });

    const summary = await processPendingAutoRecharges({ stripe: stripeWith(create), admin, now });

    expect(create).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.claimed).toBe(0);
  });

  it("closes an attempt whose card vanished after enqueue without charging", async () => {
    create.mockResolvedValue({ id: "pi_1", status: "succeeded" });
    const { admin, updates } = makeAdmin({
      candidates: [pendingAttempt()],
      settings: [savedCard({ stripe_payment_method_id: null })]
    });

    const summary = await processPendingAutoRecharges({ stripe: stripeWith(create), admin, now });

    expect(create).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(updates.some((update) => update.status === "failed")).toBe(true);
  });

  it("resets a transient error back to pending for the next pass", async () => {
    create.mockRejectedValue(new Error("network reset"));
    const { admin, updates, rpcCalls } = makeAdmin({
      candidates: [pendingAttempt()],
      settings: [savedCard()]
    });

    const summary = await processPendingAutoRecharges({ stripe: stripeWith(create), admin, now });

    expect(summary.retryable).toBe(1);
    expect(updates.some((update) => update.status === "pending")).toBe(true);
    // A transient error is not a decline: the anti-loop counter stays put.
    expect(rpcCalls.some((call) => call.name === "record_auto_recharge_failure")).toBe(false);
  });

  it("does nothing when the queue is empty", async () => {
    const { admin } = makeAdmin({ candidates: [], settings: [] });

    const summary = await processPendingAutoRecharges({ stripe: stripeWith(create), admin, now });

    expect(create).not.toHaveBeenCalled();
    expect(summary).toEqual({ claimed: 0, charged: 0, declined: 0, retryable: 0, skipped: 0 });
  });
});
