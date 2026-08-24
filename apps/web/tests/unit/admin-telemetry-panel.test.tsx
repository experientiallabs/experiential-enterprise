import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminTelemetryPanel } from "@/components/admin/AdminTelemetryPanel";
import { utcToday } from "@/lib/gateway-usage";

const ORGS = [
  { id: "org-a", name: "Acme" },
  { id: "org-b", name: "Beta Corp" }
];

const TODAY = utcToday();

function usageRow(overrides: Record<string, unknown>) {
  return {
    day: null,
    org_id: null,
    alias: null,
    user_id: null,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    spend_micro_usd: 0,
    ...overrides
  };
}

/** Dispatch the panel's reads by URL: platform rollups vs the tenant read. */
function stubUsageFetch() {
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    let rows: unknown[] = [];
    if (url.startsWith("/api/admin/telemetry/usage")) {
      if (url.includes("group_by=day")) {
        rows = [usageRow({ day: TODAY, requests: 16, spend_micro_usd: 5_000_000 })];
      } else if (url.includes("group_by=model")) {
        rows = [usageRow({ alias: "gpt-5", requests: 16, spend_micro_usd: 5_000_000 })];
      } else {
        rows = [
          usageRow({ org_id: "org-a", requests: 12, spend_micro_usd: 4_000_000 }),
          usageRow({ org_id: "org-b", requests: 4, spend_micro_usd: 1_000_000 })
        ];
      }
    } else if (url.startsWith("/api/gateway/usage/daily")) {
      rows = url.includes("group_by=model")
        ? [usageRow({ alias: "claude-opus-5", requests: 12, spend_micro_usd: 4_000_000 })]
        : [usageRow({ day: TODAY, requests: 12, spend_micro_usd: 4_000_000 })];
    }
    return Promise.resolve(
      new Response(JSON.stringify({ rows }), {
        headers: { "content-type": "application/json" }
      })
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminTelemetryPanel", () => {
  it("renders the platform total and the per-org breakdown", async () => {
    const fetchMock = stubUsageFetch();

    render(<AdminTelemetryPanel orgs={ORGS} />);

    await waitFor(() =>
      expect(screen.getByTestId("admin-usage-total")).toHaveTextContent("$5.00")
    );
    expect(screen.getByText("All organizations")).toBeInTheDocument();
    // Both active orgs appear in the breakdown, named from the roster.
    expect(screen.getByRole("button", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta Corp" })).toBeInTheDocument();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
    // The platform series is the gated admin read, not a tenant endpoint.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/admin/telemetry/usage?group_by=day")
      )
    ).toBe(true);
  });

  it("drills into one org through the tenant read and back out", async () => {
    const fetchMock = stubUsageFetch();

    render(<AdminTelemetryPanel orgs={ORGS} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Acme" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Acme" }));

    await waitFor(() =>
      expect(screen.getByTestId("admin-usage-total")).toHaveTextContent("$4.00")
    );
    expect(
      within(screen.getByTestId("admin-usage-summary")).getByText("Acme")
    ).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = String(input);
        return (
          url.startsWith("/api/gateway/usage/daily") &&
          url.includes("org=org-a") &&
          url.includes("scope=org")
        );
      })
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /All organizations/ }));
    await waitFor(() =>
      expect(screen.getByTestId("admin-usage-total")).toHaveTextContent("$5.00")
    );
  });
});
