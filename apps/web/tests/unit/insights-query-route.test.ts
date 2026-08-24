import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceNotFoundError } from "@/lib/errors";
import type { InsightAnswer } from "@/lib/types";

const requireOrgId = vi.hoisted(() => vi.fn());
const queryInsights = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/orgs", () => ({ requireOrgId }));
vi.mock("@/lib/data-source", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data-source")>("@/lib/data-source");
  return {
    ...actual,
    getDataSource: () => ({ queryInsights })
  };
});

import { POST } from "@/app/api/orgs/[orgId]/insights/query/route";

const context = { params: Promise.resolve({ orgId: "demo-slug" }) };

const answer: InsightAnswer = {
  understood: true,
  interpretation: "Spend by model over the last 7 days",
  headline: "Your most expensive model over the last 7 days was gpt-5.6-terra at $9.00.",
  metric: "spend",
  dimension: "model",
  window: "7d",
  unit: "usd",
  rows: [{ label: "gpt-5.6-terra", value: 9, detail: null }],
  caveat: null,
  examples: []
};

function post(body: unknown): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgId.mockResolvedValue("org-1");
  queryInsights.mockResolvedValue(answer);
});

describe("POST /api/orgs/[orgId]/insights/query", () => {
  it("passes the trimmed question to the org-scoped data source", async () => {
    const response = await POST(post({ question: "  which model cost me the most?  " }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(answer);
    expect(requireOrgId).toHaveBeenCalledWith("demo-slug");
    expect(queryInsights).toHaveBeenCalledWith("org-1", "which model cost me the most?");
  });

  it("rejects an empty or missing question with a 400", async () => {
    expect((await POST(post({ question: "   " }), context)).status).toBe(400);
    expect((await POST(post({}), context)).status).toBe(400);
    expect(queryInsights).not.toHaveBeenCalled();
  });

  it("rejects an over-long question with a 400", async () => {
    const response = await POST(post({ question: "a".repeat(301) }), context);
    expect(response.status).toBe(400);
    expect(queryInsights).not.toHaveBeenCalled();
  });

  it("maps an unauthorized organization to a not-found response", async () => {
    requireOrgId.mockRejectedValue(new DataSourceNotFoundError("Organization not found"));

    const response = await POST(post({ question: "how much did I spend?" }), context);

    expect(response.status).toBe(404);
  });
});
