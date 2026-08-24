import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverviewView, TopModels } from "@/components/overview/OverviewView";
import type { ApiKeyRow } from "@/lib/api-keys/types";
import { addDays, utcToday } from "@/lib/gateway-usage";

const TODAY = utcToday();

// Fixture usage: 2 requests / 1500 tokens / $3.00 today, 5 / 300 / $1.00 ten
// days ago (inside 30d, outside 7d), 9 / 900 / $9.00 forty days ago (all-time
// only). Every expectation derives from these three rows.
function dayRows(scope: string) {
  const base = { user_id: null, alias: null };
  return [
    { ...base, day: TODAY, requests: 2, input_tokens: 1_000, output_tokens: 500, spend_micro_usd: 3_000_000 },
    { ...base, day: addDays(TODAY, -10), requests: 5, input_tokens: 200, output_tokens: 100, spend_micro_usd: 1_000_000 },
    { ...base, day: addDays(TODAY, -40), requests: 9, input_tokens: 600, output_tokens: 300, spend_micro_usd: 9_000_000 },
    // Org-wide has one extra request today from a teammate.
    ...(scope === "org"
      ? [{ ...base, day: TODAY, requests: 1, input_tokens: 50, output_tokens: 50, spend_micro_usd: 500_000 }]
      : [])
  ];
}

const MODEL_ROWS = [
  { day: null, user_id: null, alias: "claude-opus-5", requests: 4, input_tokens: 900, output_tokens: 400, spend_micro_usd: 3_500_000 },
  { day: null, user_id: null, alias: "gpt-5.6", requests: 3, input_tokens: 300, output_tokens: 200, spend_micro_usd: 500_000 }
];

// Per-(day, model) cells under today's $3.00 day total: $2.50 + $0.40 named,
// leaving a $0.10 residual so the stacked hero grows an "Other" fold.
const DAY_MODEL_ROWS = [
  { day: TODAY, user_id: null, alias: "claude-opus-5", requests: 1, input_tokens: 800, output_tokens: 400, spend_micro_usd: 2_500_000 },
  { day: TODAY, user_id: null, alias: "gpt-5.6", requests: 1, input_tokens: 150, output_tokens: 50, spend_micro_usd: 400_000 },
  { day: addDays(TODAY, -10), user_id: null, alias: "gpt-5.6", requests: 5, input_tokens: 200, output_tokens: 100, spend_micro_usd: 1_000_000 }
];

const MEMBER_ROWS = [
  { day: null, user_id: "u1", alias: null, requests: 6, input_tokens: 1_100, output_tokens: 550, spend_micro_usd: 3_500_000 },
  { day: null, user_id: null, alias: null, requests: 2, input_tokens: 250, output_tokens: 150, spend_micro_usd: 1_000_000 }
];

/** Every URL the page and its mounted sections may read, keyed by pathname. */
function stubFetch(
  options: {
    keys?: ApiKeyRow[];
    /** Fails the grouped reads whose bounds match, as a period switch would. */
    failGroupedFrom?: string;
    /** 500 the roster read (the directory hiccup case). */
    failRoster?: boolean;
    /** 500 the per-(day, model) read (the stacked-breakdown failure case). */
    failDayModel?: boolean;
  } = {}
) {
  const keys = options.keys ?? [];
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url);
    if (url.pathname === "/api/gateway/usage/daily") {
      const scope = url.searchParams.get("scope") ?? "self";
      const groupBy = url.searchParams.get("group_by") ?? "day";
      if (
        options.failGroupedFrom !== undefined &&
        url.searchParams.get("from") === options.failGroupedFrom
      ) {
        return Response.json({ error: "Usage is temporarily unavailable." }, { status: 503 });
      }
      if (groupBy === "day_model" && options.failDayModel) {
        return Response.json({ error: "usage read failed" }, { status: 500 });
      }
      const rows =
        groupBy === "day"
          ? dayRows(scope)
          : groupBy === "day_model"
            ? DAY_MODEL_ROWS
            : groupBy === "model"
              ? MODEL_ROWS
              : MEMBER_ROWS;
      return Response.json({ org_id: "org-1", scope, group_by: groupBy, rows });
    }
    if (url.pathname === "/api/orgs/org-1/members") {
      if (options.failRoster) {
        return Response.json({ error: "roster unavailable" }, { status: 500 });
      }
      return Response.json({
        members: [{ userId: "u1", email: "ada@acme.dev", role: "admin" }],
        invites: [],
        can_manage: true
      });
    }
    if (url.pathname === "/api/keys") {
      return Response.json({ keys, page: 1, pageCount: 1, total: keys.length });
    }
    throw new Error(`Unstubbed fetch: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function keyRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "k1",
    org_id: "org-1",
    name: "default",
    key_prefix: "xpl_live_abcd",
    key_suffix: "f2e1",
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    identity_id: null,
    ...overrides
  };
}

function usageCalls(calls: URL[]): URL[] {
  return calls.filter((url) => url.pathname === "/api/gateway/usage/daily");
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OverviewView scopes", () => {
  it("members land on Personal with no switcher, reading scope=self", async () => {
    const calls = stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);

    await screen.findByTestId("usage-total");
    expect(screen.queryByRole("navigation", { name: "Scope" })).toBeNull();
    expect(screen.getByText("Your usage")).toBeInTheDocument();
    expect(screen.queryByTestId("members-breakdown")).toBeNull();
    expect(usageCalls(calls).every((url) => url.searchParams.get("scope") === "self")).toBe(true);
  });

  it("admins land on Workspace (listed first) with the members section", async () => {
    const calls = stubFetch();
    render(<OverviewView canSeeWorkspace knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);

    await screen.findByTestId("usage-total");
    expect(screen.getByText("Workspace usage")).toBeInTheDocument();
    expect(usageCalls(calls).every((url) => url.searchParams.get("scope") === "org")).toBe(true);

    // Workspace leads the switcher; Personal is the secondary cut (the product owner).
    const scopeTabs = within(screen.getByRole("navigation", { name: "Scope" })).getAllByRole(
      "button"
    );
    expect(scopeTabs.map((tab) => tab.textContent)).toEqual(["Workspace", "Personal"]);

    // Per-member breakdown with roster emails and the unattributed bucket.
    const breakdown = await screen.findByTestId("members-breakdown");
    await waitFor(() => expect(breakdown).toHaveTextContent("ada@acme.dev"));
    expect(breakdown).toHaveTextContent("Unattributed keys");
    expect(breakdown).toHaveTextContent("2 active members");
  });

  it("shows Personal as the contribution graph only — no members section", async () => {
    const calls = stubFetch();
    render(<OverviewView canSeeWorkspace knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");

    fireEvent.click(screen.getByRole("button", { name: "Personal" }));
    expect(screen.getByText("Your usage")).toBeInTheDocument();
    // Members belong to the Workspace view only; Personal shows the activity
    // contribution graph in that slot (the product owner).
    expect(screen.getByTestId("activity-section")).toBeInTheDocument();
    expect(screen.queryByTestId("members-breakdown")).toBeNull();
    await waitFor(() =>
      expect(usageCalls(calls).some((url) => url.searchParams.get("scope") === "self")).toBe(true)
    );
  });
});

describe("OverviewView metric and period toggles", () => {
  it("re-renders every section in the chosen metric consistently", async () => {
    stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);

    // Default: spend over 30d = $3.00 + $1.00.
    expect(await screen.findByTestId("usage-total")).toHaveTextContent("$4.00");
    // The activity graph is a fixed 90-day window, independent of the period:
    // it also picks up the 40-days-ago $9.00 row, so its total is $13.00.
    const activity = screen.getByTestId("activity-section");
    expect(activity).toHaveTextContent("$13.00");
    const topModels = screen.getByTestId("top-models");
    await waitFor(() => expect(topModels).toHaveTextContent("claude-opus-5"));
    expect(topModels).toHaveTextContent("$3.50");

    // Requests: summary and top models flip with the metric (30d = 7); the
    // 90-day activity total flips to 16 (2 + 5 + 9).
    fireEvent.click(screen.getByRole("button", { name: "Requests" }));
    expect(screen.getByTestId("usage-total")).toHaveTextContent("7");
    expect(screen.getByTestId("activity-section")).toHaveTextContent("16");
    expect(screen.getByTestId("top-models")).toHaveTextContent("4");

    // Tokens: 1500 + 300 within 30 days.
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByTestId("usage-total")).toHaveTextContent("1.8k");
  });

  it("re-cuts every section to the chosen period, with the delta honest", async () => {
    const calls = stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);

    await screen.findByTestId("usage-total");

    // Today: only today's $3.00; the 10-days-ago row falls out.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("usage-total")).toHaveTextContent("$3.00");
    // No activity yesterday -> no baseline -> the delta does not render.
    expect(screen.queryByTestId("usage-delta")).toBeNull();

    // All time picks up the 40-days-ago row too, and has no previous period.
    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(screen.getByTestId("usage-total")).toHaveTextContent("$13.00");
    expect(screen.queryByTestId("usage-delta")).toBeNull();

    // The grouped top-models read is re-bounded to each period.
    await waitFor(() => {
      const modelCalls = usageCalls(calls).filter(
        (url) => url.searchParams.get("group_by") === "model"
      );
      expect(modelCalls.length).toBeGreaterThanOrEqual(3);
      expect(modelCalls[modelCalls.length - 1].searchParams.get("from")).toBeNull();
    });
  });

  it("never leaves the previous period's rows under the new period after a failed read", async () => {
    // 7d fails; 30d (the landing period) succeeds, so the grouped sections
    // hold rows that answer a period the page is no longer showing.
    stubFetch({ failGroupedFrom: addDays(TODAY, -6) });
    render(<OverviewView canSeeWorkspace knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);

    const topModels = await screen.findByTestId("top-models");
    const breakdown = screen.getByTestId("members-breakdown");
    await waitFor(() => expect(topModels).toHaveTextContent("claude-opus-5"));
    await waitFor(() => expect(breakdown).toHaveTextContent("ada@acme.dev"));

    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() =>
      expect(topModels).toHaveTextContent("Usage is temporarily unavailable.")
    );
    expect(topModels).not.toHaveTextContent("claude-opus-5");
    await waitFor(() =>
      expect(breakdown).toHaveTextContent("Usage is temporarily unavailable.")
    );
    expect(breakdown).not.toHaveTextContent("ada@acme.dev");
    expect(breakdown).not.toHaveTextContent("active member");
  });

  it("shows the previous-period delta when a baseline exists", async () => {
    stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");

    // 1y window: current = $4 + $9 = $13... the 40-day row sits inside 1y, so
    // current is $13.00 and the previous year is empty -> no delta. Switch to
    // 30d where previous-30d holds the $9.00 row: delta = (4-9)/9.
    expect(await screen.findByTestId("usage-delta")).toHaveTextContent("-56% vs the previous 30 days");
  });

  it("prompts to create a key when the org has none, and never mounts credits", async () => {
    stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    const keySection = await screen.findByTestId("your-api-key-section");
    // Credit balances consolidated onto /credits; the overview no longer
    // mounts a balance card or per-provider credit accounts.
    expect(screen.queryByTestId("credit-balance-card")).toBeNull();
    expect(screen.queryByTestId("credit-accounts-section")).toBeNull();
    expect(await within(keySection).findByText(/No active API keys yet/)).toBeInTheDocument();
  });

  it("shows the org's newest key masked to prefix…suffix, with no copy control", async () => {
    stubFetch({ keys: [keyRow({ name: "prod", key_prefix: "xpl_live_beef" })] });
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    const keySection = await screen.findByTestId("your-api-key-section");
    expect(await within(keySection).findByText("prod")).toBeInTheDocument();
    expect(within(keySection).getByText("xpl_live_beef…f2e1")).toBeInTheDocument();
    // Only the stored prefix+suffix exist server-side; copying that fragment
    // is useless, so the card offers no copy affordance.
    expect(within(keySection).queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("renders a pre-suffix key prefix-only rather than inventing a tail", async () => {
    stubFetch({ keys: [keyRow({ name: "legacy", key_prefix: "xpl_live_beef", key_suffix: null })] });
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    const keySection = await screen.findByTestId("your-api-key-section");
    expect(await within(keySection).findByText("xpl_live_beef…")).toBeInTheDocument();
  });

  it("summarizes multiple active keys with a count and a masked table", async () => {
    stubFetch({
      keys: [
        keyRow({ id: "k1", name: "prod", key_prefix: "xpl_live_beef", created_at: "2026-08-10T00:00:00Z" }),
        keyRow({ id: "k2", name: "staging", key_prefix: "xpl_live_cafe", created_at: "2026-07-01T00:00:00Z" })
      ]
    });
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    const keySection = await screen.findByTestId("your-api-key-section");
    // Count and both keys' masked prefixes render; "newest" reads the head row.
    expect(await within(keySection).findByText(/2 active keys/)).toBeInTheDocument();
    expect(within(keySection).getByText(/newest Aug 10, 2026/)).toBeInTheDocument();
    expect(within(keySection).getByText("staging")).toBeInTheDocument();
    expect(within(keySection).getByText(/xpl_live_cafe…/)).toBeInTheDocument();
  });

  it("keeps the members section when the roster read fails (never hide on unknown)", async () => {
    const calls = stubFetch({ failRoster: true });
    render(<OverviewView canSeeWorkspace knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    await waitFor(() =>
      expect(calls.some((url) => url.pathname === "/api/orgs/org-1/members")).toBe(true)
    );
    // A directory hiccup must not disappear a real team's breakdown: with the
    // roster unknown, the section stays (names fall back to raw member ids).
    expect(await screen.findByTestId("members-breakdown")).toBeInTheDocument();
  });

  it("falls back to flat bars when the per-model breakdown read fails", async () => {
    stubFetch({ failDayModel: true });
    render(
      <OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />
    );
    await screen.findByTestId("usage-total");
    // The summary and chart render from the day series; no legend appears
    // because no stacks were mounted.
    const chart = screen.getByTestId("daily-usage-chart");
    await waitFor(() => {
      const topModels = screen.getByTestId("top-models");
      expect(topModels).toHaveTextContent("claude-opus-5");
    });
    expect(chart).not.toHaveTextContent("claude-opus-5");
    expect(chart).not.toHaveTextContent("Other");
  });

  it("stacks the hero chart by model with an Other residual, bounded to the period", async () => {
    const calls = stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");

    // The legend names the spend-ranked models plus the residual fold.
    const chart = screen.getByTestId("daily-usage-chart");
    await waitFor(() => expect(chart).toHaveTextContent("claude-opus-5"));
    expect(chart).toHaveTextContent("gpt-5.6");
    expect(chart).toHaveTextContent("Other");

    // The per-model read is re-bounded to the selected period (default 30d),
    // unlike the all-time day series it stacks against.
    const stackCalls = usageCalls(calls).filter(
      (url) => url.searchParams.get("group_by") === "day_model"
    );
    expect(stackCalls.length).toBeGreaterThanOrEqual(1);
    const latest = stackCalls[stackCalls.length - 1];
    expect(latest.searchParams.get("from")).toBe(addDays(TODAY, -29));
    expect(latest.searchParams.get("to")).toBe(TODAY);
  });

  it("links each top model row to its catalog page with the raw slug", async () => {
    stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    const topModels = screen.getByTestId("top-models");
    const link = await within(topModels).findByRole("link", { name: /claude-opus-5/ });
    expect(link).toHaveAttribute("href", "/models/claude-opus-5");
  });

  it("links out to Insights carrying the period's window", async () => {
    stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    // Default period is 30d, so the link lands on the 30d Insights cut.
    const link = screen.getByRole("link", { name: "View full activity" });
    expect(link).toHaveAttribute("href", "/insights?window=30d");
    // 7d is Insights' default window: the canonical URL stays parameterless.
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByRole("link", { name: "View full activity" })).toHaveAttribute(
      "href",
      "/insights"
    );
    // Today maps to the closest Insights window, 24h.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("link", { name: "View full activity" })).toHaveAttribute(
      "href",
      "/insights?window=24h"
    );
  });

  it("colors each top-model row's bar with the chart's series color", async () => {
    stubFetch();
    render(<OverviewView canSeeWorkspace={false} knownModelSlugs={null} org={{ id: "org-1", name: "Acme" }} />);
    await screen.findByTestId("usage-total");
    // Wait for the stacked hero (its legend names the models); the rail then
    // wears the same assignment: claude leads range spend (rank 1 = ink),
    // gpt is rank 2 (green) — regardless of the rail's own metric ordering.
    const chart = screen.getByTestId("daily-usage-chart");
    await waitFor(() => expect(chart).toHaveTextContent("claude-opus-5"));
    const topModels = screen.getByTestId("top-models");
    const claudeBar = within(
      within(topModels).getByRole("link", { name: /claude-opus-5/ })
    ).getByTestId("top-model-bar");
    const gptBar = within(within(topModels).getByRole("link", { name: /gpt-5\.6/ })).getByTestId(
      "top-model-bar"
    );
    expect(claudeBar).toHaveStyle({ backgroundColor: "#1a1a1a" });
    expect(gptBar).toHaveStyle({ backgroundColor: "#168a49" });
  });
});

describe("TopModels card", () => {
  it("caps the list to fit the card — no inner scroll region", () => {
    // Nine active models: the card shows the leading six and links the rest
    // out; nothing inside the card is a scroll container ("top models by
    // spend now has a scroll which we should not have" — the product owner).
    const rows = Array.from({ length: 9 }, (_, index) => ({
      day: null,
      user_id: null,
      alias: `model-${index}`,
      requests: 9 - index,
      input_tokens: 0,
      output_tokens: 0,
      spend_micro_usd: (9 - index) * 1_000_000
    }));
    render(<TopModels error={null} loading={false} metric="spend" rows={rows} />);
    const card = screen.getByTestId("top-models");
    expect(within(card).getAllByRole("listitem")).toHaveLength(6);
    expect(within(card).getByRole("link", { name: /View all \(9\)/ })).toHaveAttribute(
      "href",
      "/insights"
    );
    expect(card.querySelector('[class*="overflow-y-auto"]')).toBeNull();
  });
});
