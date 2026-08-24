import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));

import { POST } from "@/app/api/stripe/webhook/route";

// Real signature verification against a test signing secret: the header is
// produced by the SDK's own test helper, so a tampered payload genuinely
// fails and a valid one genuinely passes.
const WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests";

function completedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_abc123",
    object: "checkout.session",
    client_reference_id: "org-1",
    metadata: { purpose: "platform-credit-topup", org_id: "org-1", requested_by: "user-1" },
    amount_total: 2500,
    currency: "usd",
    payment_status: "paid",
    ...overrides
  };
}

function eventPayload(
  type: string,
  object: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    id: "evt_test_1",
    object: "event",
    api_version: "2026-06-30",
    // Tests run with a test-mode key, so a matching event is livemode false.
    livemode: false,
    type,
    data: { object },
    ...overrides
  });
}

async function signedRequest(payload: string, secret = WEBHOOK_SECRET): Promise<Request> {
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("https://platform.example/api/stripe/webhook", {
    body: payload,
    headers: { "stripe-signature": signature },
    method: "POST"
  });
}

type LedgerInsert = Record<string, unknown>;

function fakeAdmin(options: {
  orgExists?: boolean;
  orgError?: { message: string } | null;
  insertError?: { code: string; message: string } | null;
}) {
  const inserts: LedgerInsert[] = [];
  createServiceRoleSupabaseClient.mockReturnValue({
    from: (table: string) => {
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  options.orgError || options.orgExists === false ? null : { id: "org-1" },
                error: options.orgError ?? null
              })
            })
          })
        };
      }
      expect(table).toBe("credit_ledger");
      return {
        insert: async (row: LedgerInsert) => {
          inserts.push(row);
          return { error: options.insertError ?? null };
        }
      };
    }
  });
  return inserts;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/stripe/webhook", () => {
  it("rejects a payload signed with the wrong secret", async () => {
    fakeAdmin({});
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession()),
      "whsec_wrong_secret"
    );

    const response = await POST(request as never);

    expect(response.status).toBe(400);
  });

  it("answers 503, not a signature error, when Stripe is not configured", async () => {
    fakeAdmin({});
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession())
    );

    const response = await POST(request as never);

    expect(response.status).toBe(503);
  });

  it("accepts a live event on a live-keyed deployment", async () => {
    // The livemode guard compares, not rejects: live+live must pass just as
    // test+test does, or production would refuse every real payment.
    const inserts = fakeAdmin({});
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_dummy");
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession(), { livemode: true })
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true });
    expect(inserts).toHaveLength(1);
  });

  it("rejects an event whose livemode does not match the deployment's key", async () => {
    const inserts = fakeAdmin({});
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession(), { livemode: true })
    );

    const response = await POST(request as never);

    expect(response.status).toBe(400);
    expect(inserts).toEqual([]);
  });

  it("refuses to guess when amount_total diverges from amount_subtotal", async () => {
    const inserts = fakeAdmin({});
    const request = await signedRequest(
      eventPayload(
        "checkout.session.completed",
        completedSession({ amount_total: 2750, amount_subtotal: 2500 })
      )
    );

    const response = await POST(request as never);

    expect(response.status).toBe(500);
    expect(inserts).toEqual([]);
  });

  it("credits normally when amount_subtotal equals amount_total", async () => {
    const inserts = fakeAdmin({});
    const request = await signedRequest(
      eventPayload(
        "checkout.session.completed",
        completedSession({ amount_total: 2500, amount_subtotal: 2500 })
      )
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].amount_usd).toBe(25);
  });

  it("rejects a missing signature header", async () => {
    fakeAdmin({});
    const request = new Request("https://platform.example/api/stripe/webhook", {
      body: eventPayload("checkout.session.completed", completedSession()),
      method: "POST"
    });

    const response = await POST(request as never);

    expect(response.status).toBe(400);
  });

  it("credits the ledger once per completed session, from Stripe's own amount", async () => {
    const inserts = fakeAdmin({});
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession())
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true });
    expect(inserts).toEqual([
      {
        org_id: "org-1",
        entry_type: "topup",
        amount_usd: 25,
        reason: "Credit top-up",
        source: "stripe",
        source_ref: "cs_test_abc123",
        created_by: "user-1"
      }
    ]);
  });

  it("treats a replayed event as converged, not an error", async () => {
    fakeAdmin({ insertError: { code: "23505", message: "duplicate key" } });
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession())
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      handled: true,
      replay: true
    });
  });

  it("falls back to metadata.org_id when client_reference_id is absent", async () => {
    const inserts = fakeAdmin({});
    const request = await signedRequest(
      eventPayload(
        "checkout.session.completed",
        completedSession({ client_reference_id: null })
      )
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].org_id).toBe("org-1");
  });

  it("acknowledges but never credits unpaid or foreign sessions", async () => {
    const inserts = fakeAdmin({});

    const unpaid = await POST(
      (await signedRequest(
        eventPayload("checkout.session.completed", completedSession({ payment_status: "unpaid" }))
      )) as never
    );
    const foreign = await POST(
      (await signedRequest(
        eventPayload(
          "checkout.session.completed",
          completedSession({ client_reference_id: null, metadata: {} })
        )
      )) as never
    );
    // A different product's Checkout in the same Stripe account: no purpose
    // marker, so it must never mint credits even with a colliding org id.
    const unmarked = await POST(
      (await signedRequest(
        eventPayload(
          "checkout.session.completed",
          completedSession({ metadata: { org_id: "org-1" } })
        )
      )) as never
    );
    const nonUsd = await POST(
      (await signedRequest(
        eventPayload("checkout.session.completed", completedSession({ currency: "eur" }))
      )) as never
    );
    const otherEvent = await POST(
      (await signedRequest(eventPayload("payment_intent.succeeded", { id: "pi_1" }))) as never
    );
    const zeroAmount = await POST(
      (await signedRequest(
        eventPayload("checkout.session.completed", completedSession({ amount_total: 0 }))
      )) as never
    );
    const missingAmount = await POST(
      (await signedRequest(
        eventPayload("checkout.session.completed", completedSession({ amount_total: null }))
      )) as never
    );

    for (const response of [unpaid, foreign, unmarked, nonUsd, otherEvent, zeroAmount, missingAmount]) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true, handled: false });
    }
    expect(inserts).toEqual([]);
  });

  it("acknowledges a paid session for a deleted org without crediting", async () => {
    const inserts = fakeAdmin({ orgExists: false });
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession())
    );

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, handled: false });
    expect(inserts).toEqual([]);
  });

  it("returns 500 when the org lookup fails so Stripe retries", async () => {
    const inserts = fakeAdmin({ orgError: { message: "connection reset" } });
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession())
    );

    const response = await POST(request as never);

    expect(response.status).toBe(500);
    expect(inserts).toEqual([]);
  });

  it("returns 500 on a database failure so Stripe retries", async () => {
    fakeAdmin({ insertError: { code: "XX000", message: "db down" } });
    const request = await signedRequest(
      eventPayload("checkout.session.completed", completedSession())
    );

    const response = await POST(request as never);

    expect(response.status).toBe(500);
  });
});
