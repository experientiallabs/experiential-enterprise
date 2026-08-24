import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpendOverviewCard } from "@/components/billing/SpendOverviewCard";
import type { OrgUsageReport } from "@/lib/types";

const report: OrgUsageReport = {
  credit: {
    spend_usd: 12.5,
    billable_spend_usd: 9,
    credit_granted_usd: 20,
    credit_balance_usd: 11,
    yc: null
  }
};

const HOUR = 3600;

function stubUsageFetch({
  buckets = [] as unknown[],
  providers = [] as unknown[]
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/usage/timeseries")) {
      return {
        ok: true,
        json: async () => ({ window: "7d", bucket_seconds: HOUR, buckets })
      };
    }
    if (url.includes("/usage/by-provider")) {
      return { ok: true, json: async () => ({ window: "7d", providers }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function providerRow(provider: string | null, costUsd: number, estimatedUsd: number) {
  return {
    provider,
    request_count: 10,
    error_count: 0,
    input_tokens: 100,
    output_tokens: 100,
    cost_usd: costUsd,
    estimated_cost_usd: estimatedUsd,
    last_used_at: "2026-08-22T00:00:00Z"
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpendOverviewCard", () => {
  it("shows one combined headline: all spend and credits left, no funding split", async () => {
    stubUsageFetch();
    await act(async () => {
      render(<SpendOverviewCard orgId="org-1" report={report} />);
    });

    // 12.50 total (9 platform + 3.50 byok) shown as ONE figure.
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText("$11.00")).toBeInTheDocument();
    expect(screen.getByText("of $20.00")).toBeInTheDocument();
    expect(screen.queryByText("Platform credits")).not.toBeInTheDocument();
    expect(screen.queryByText("Your own keys")).not.toBeInTheDocument();
  });

  it("fetches the picked window's timeseries and per-provider rollups", async () => {
    const fetchMock = stubUsageFetch();
    await act(async () => {
      render(<SpendOverviewCard orgId="org-1" report={report} />);
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/usage/timeseries?window=7d"))).toBe(true);
    expect(urls.some((url) => url.includes("/usage/by-provider?window=7d"))).toBe(true);

    // Switching the window refetches both.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "30d" }));
    });
    const after = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(after.some((url) => url.includes("/usage/timeseries?window=30d"))).toBe(true);
    expect(after.some((url) => url.includes("/usage/by-provider?window=30d"))).toBe(true);
  });

  it("lists spend per provider, biggest first, dollars combined", async () => {
    stubUsageFetch({
      buckets: [
        {
          bucket_start: new Date().toISOString(),
          model: "m1",
          lane: "platform",
          request_count: 1,
          error_count: 0,
          input_tokens: 1,
          output_tokens: 1,
          cost_usd: 1,
          estimated_cost_usd: 0
        }
      ],
      providers: [providerRow("openai", 1, 0.5), providerRow("anthropic", 4, 0)]
    });
    await act(async () => {
      render(<SpendOverviewCard orgId="org-1" report={report} />);
    });

    const list = screen.getByTestId("spend-by-provider");
    const rows = within(list).getAllByTestId(/spend-provider-/);
    expect(rows[0]).toHaveTextContent("Anthropic");
    expect(rows[0]).toHaveTextContent("$4.00");
    expect(rows[1]).toHaveTextContent("OpenAI");
    // Charged plus attributed estimate, combined.
    expect(rows[1]).toHaveTextContent("$1.50");
  });

  it("renders signed-out with an empty state and zero fetches", async () => {
    const fetchMock = stubUsageFetch();
    await act(async () => {
      render(<SpendOverviewCard orgId={null} report={report} />);
    });

    expect(screen.getByTestId("spend-empty")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
