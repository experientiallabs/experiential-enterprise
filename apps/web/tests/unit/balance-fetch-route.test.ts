import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runScheduledBalanceFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/data-source", () => ({
  getInternalDataSource: () => ({ runScheduledBalanceFetch })
}));

import { POST } from "@/app/api/internal/balance-fetch/route";
import type { NextRequest } from "next/server";

const CRON_SECRET = "cron-secret-under-test";

function request(bearer?: string): NextRequest {
  const headers = bearer !== undefined ? { authorization: `Bearer ${bearer}` } : undefined;
  return new Request("http://localhost/api/internal/balance-fetch", {
    method: "POST",
    headers
  }) as unknown as NextRequest;
}

const SUMMARY = {
  providersChecked: 3,
  providerSnapshotsWritten: 2,
  providersSkippedFloor: 1,
  toolAccountsChecked: 4,
  toolBalancesUpdated: 2,
  errors: 0
};

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  runScheduledBalanceFetch.mockResolvedValue(SUMMARY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/internal/balance-fetch", () => {
  it("is a not-found without a bearer, running nothing", async () => {
    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(runScheduledBalanceFetch).not.toHaveBeenCalled();
  });

  it("is a not-found with a wrong bearer", async () => {
    const response = await POST(request("wrong-secret"));

    expect(response.status).toBe(404);
    expect(runScheduledBalanceFetch).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is not deployed", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const response = await POST(request(""));

    expect(response.status).toBe(404);
    expect(runScheduledBalanceFetch).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns its summary for a valid bearer", async () => {
    const response = await POST(request(CRON_SECRET));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SUMMARY);
    expect(runScheduledBalanceFetch).toHaveBeenCalledOnce();
  });
});
