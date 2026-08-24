import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createServiceRoleSupabaseClient = vi.hoisted(() => vi.fn());
const sendSpendAlertEmail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/admin", () => ({ createServiceRoleSupabaseClient }));
vi.mock("@/lib/billing/spend-alert-email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing/spend-alert-email")>(
    "@/lib/billing/spend-alert-email"
  );
  return { ...actual, sendSpendAlertEmail };
});

import { POST } from "@/app/api/internal/spend-alerts/route";
import { straightLineMonthProjection } from "@/lib/billing/spend-alert-email";
import type { NextRequest } from "next/server";

const CRON_SECRET = "cron-secret-under-test";

function request(options: { bearer?: string; dryRun?: boolean } = {}): NextRequest {
  const url = `http://localhost/api/internal/spend-alerts${options.dryRun ? "?dryRun=1" : ""}`;
  const headers = options.bearer ? { authorization: `Bearer ${options.bearer}` } : undefined;
  return new Request(url, { method: "POST", headers }) as unknown as NextRequest;
}

function dueRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    alert_id: "al-1",
    period: "2026-08",
    kind: "org_monthly_spend",
    org_id: "org-1",
    org_name: "Acme",
    notify_email: "finance@acme.test",
    budget_id: null,
    budget_scope_kind: null,
    measured_micro_usd: 120_000_000,
    threshold_micro_usd: 100_000_000,
    limit_micro_usd: null,
    fired_at: "2026-08-21T10:00:00Z",
    ...overrides
  };
}

const rpc = vi.fn();

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  rpc.mockReset();
  createServiceRoleSupabaseClient.mockReturnValue({ rpc });
  sendSpendAlertEmail.mockResolvedValue({ sent: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/internal/spend-alerts", () => {
  it("answers 404 without the cron bearer so the route is not probeable", async () => {
    const response = await POST(request());
    expect(response.status).toBe(404);
    const wrong = await POST(request({ bearer: "wrong" }));
    expect(wrong.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("delivers each due claim and marks it with a null error", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "gateway_spend_alerts_due" ? { data: [dueRow()], error: null } : { error: null }
    );
    const response = await POST(request({ bearer: CRON_SECRET }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 1, delivered: 1, failed: 0 });
    expect(sendSpendAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendSpendAlertEmail.mock.calls[0][0]).toMatchObject({
      to: "finance@acme.test",
      orgName: "Acme",
      kind: "org_monthly_spend",
      period: "2026-08",
      measuredMicroUsd: 120_000_000,
      thresholdMicroUsd: 100_000_000
    });
    expect(rpc).toHaveBeenCalledWith("gateway_spend_alert_mark", {
      p_alert_id: "al-1",
      p_period: "2026-08",
      p_error: null
    });
  });

  it("records the send failure reason and keeps processing the batch", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "gateway_spend_alerts_due"
        ? { data: [dueRow(), dueRow({ alert_id: "al-2" })], error: null }
        : // Even a failing mark call must not abort the loop.
          { error: { message: "mark blew up" } }
    );
    sendSpendAlertEmail.mockResolvedValueOnce({ sent: false, reason: "Resend down" });
    const response = await POST(request({ bearer: CRON_SECRET }));
    expect(await response.json()).toEqual({ processed: 2, delivered: 1, failed: 1 });
    expect(rpc).toHaveBeenCalledWith("gateway_spend_alert_mark", {
      p_alert_id: "al-1",
      p_period: "2026-08",
      p_error: "Resend down"
    });
    expect(rpc).toHaveBeenCalledWith("gateway_spend_alert_mark", {
      p_alert_id: "al-2",
      p_period: "2026-08",
      p_error: null
    });
  });

  it("returns the claims without sending on dryRun=1, releasing their leases", async () => {
    rpc.mockResolvedValue({ data: [dueRow()], error: null });
    const response = await POST(request({ bearer: CRON_SECRET, dryRun: true }));
    const payload = await response.json();
    expect(payload.processed).toBe(1);
    expect(payload.rows).toHaveLength(1);
    expect(sendSpendAlertEmail).not.toHaveBeenCalled();
    // The due() read leased the claim; the dry run must hand the lease back
    // (a "dry run" failure mark) so the next real tick is not delayed.
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("gateway_spend_alert_mark", {
      p_alert_id: "al-1",
      p_period: "2026-08",
      p_error: "dry run"
    });
  });
});

describe("straightLineMonthProjection", () => {
  it("runs the month-to-date figure forward at its average daily pace, in UTC", () => {
    // Aug 10 of a 31-day month: $100 so far projects to $310 by month end.
    const projected = straightLineMonthProjection(
      100_000_000,
      new Date(Date.UTC(2026, 7, 10, 12, 0, 0))
    );
    expect(projected).toBe(310_000_000);
  });
});
