import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RequestsSection } from "@/components/telemetry-page/requests-table";
import type { UsageRequestItem } from "@/lib/types";

function requestItem(overrides: Partial<UsageRequestItem>): UsageRequestItem {
  return {
    request_id: "req-1",
    model: "gpt-5",
    provider: "openai",
    lane: "platform",
    api_key_id: "key-1",
    key_label: "prod-agent",
    input_tokens: 100,
    output_tokens: 20,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0.01,
    estimated_cost_usd: 0,
    real_cost_usd: 0.01,
    pricing_known: true,
    latency_ms: 300,
    ttft_ms: null,
    status: "completed",
    attempt_count: 1,
    created_at: "2026-08-18T10:00:00+00:00",
    tools_used: [],
    failure_class: null,
    error_message: null,
    prompt_group: null,
    conversation_group: null,
    ...overrides
  };
}

function renderSection(requests: UsageRequestItem[]) {
  render(
    <RequestsSection orgId="org-1"
      requests={requests}
      errorsOnly={false}
      onToggleErrorsOnly={vi.fn()}
      hasMore={false}
      loadingMore={false}
      onLoadMore={vi.fn()}
      loading={false}
      error={null}
    />
  );
}

describe("RequestsSection tools surface", () => {
  it("shows the honest empty state when no request captured a tool", () => {
    // The current state everywhere: the WMO runtime surfaces no tool names.
    renderSection([requestItem({ request_id: "r1" }), requestItem({ request_id: "r2" })]);
    expect(screen.getByText("No tool calls recorded yet")).toBeInTheDocument();
    // The per-row Tools column still renders (as a muted dash), not blank.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("summarizes top tools and lists per-request tool names when captured", () => {
    renderSection([
      requestItem({ request_id: "r1", tools_used: ["web_search", "fetch_url"] }),
      requestItem({ request_id: "r2", tools_used: ["web_search"] })
    ]);
    expect(screen.queryByText("No tool calls recorded yet")).not.toBeInTheDocument();
    const summary = screen.getByText("Tools called").parentElement as HTMLElement;
    // web_search led both requests; the summary count reflects that.
    expect(within(summary).getByText("2")).toBeInTheDocument();
    expect(within(summary).getAllByText("web_search").length).toBeGreaterThan(0);
    expect(within(summary).getByText("fetch_url")).toBeInTheDocument();
  });
});

describe("RequestsSection per-request columns", () => {
  it("labels the provider, splits input/output, and derives speed (tok/s)", () => {
    // 600 output tokens over 2s = 300 tok/s. Provider reads the customer-facing
    // name, and input/output are their own columns now (OpenRouter-style Logs).
    renderSection([
      requestItem({
        request_id: "r1",
        provider: "anthropic",
        input_tokens: 1234,
        output_tokens: 600,
        latency_ms: 2000
      })
    ]);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("600")).toBeInTheDocument();
    expect(screen.getByText("300 tok/s")).toBeInTheDocument();
  });

  it("shows a dash for speed when the row has no latency or no output", () => {
    renderSection([
      requestItem({ request_id: "r1", output_tokens: 0, latency_ms: 500 }),
      requestItem({ request_id: "r2", output_tokens: 50, latency_ms: null })
    ]);
    // Neither row can honestly report a rate, so both speed cells read as a dash.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows TTFT in ms when captured and a dash when no first token was observed", () => {
    renderSection([
      requestItem({ request_id: "r1", ttft_ms: 420 }),
      requestItem({ request_id: "r2", ttft_ms: 2600 }),
      requestItem({ request_id: "r3", ttft_ms: null })
    ]);
    expect(screen.getByText("TTFT")).toBeInTheDocument();
    expect(screen.getByText("420ms")).toBeInTheDocument();
    // Long first-token waits fold to seconds, same scale as the latency cell.
    expect(screen.getByText("2.6s")).toBeInTheDocument();
    // The uncaptured row reads as a dash (null is never rendered as 0ms).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });
});

describe("RequestsSection cost surface", () => {
  it("shows the real per-call cost at sub-cent precision, never $0.00", () => {
    // A small platform-funded call must show its actual spend, not $0.00.
    renderSection([
      requestItem({ request_id: "r1", cost_usd: 0.002026, real_cost_usd: 0.002026 })
    ]);
    expect(screen.getByText("$0.002026")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("shows a BYOK call's real cost from the never-charged estimate, labeled est.", () => {
    // cost_usd is 0 (BYOK is never charged) but the real cost lives in the
    // estimate — it must not read as a free $0.00 call.
    renderSection([
      requestItem({
        request_id: "r1",
        lane: "byok",
        cost_usd: 0,
        estimated_cost_usd: 0.0031,
        real_cost_usd: 0.0031
      })
    ]);
    expect(screen.getByText("$0.0031")).toBeInTheDocument();
    expect(screen.getByText("est.")).toBeInTheDocument();
  });

  it("says 'unpriced' rather than $0.00 when the route had no known price", () => {
    renderSection([
      requestItem({
        request_id: "r1",
        cost_usd: 0,
        estimated_cost_usd: 0,
        real_cost_usd: 0,
        pricing_known: false
      })
    ]);
    expect(screen.getByText("unpriced")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });
});

describe("RequestsSection outcome reason", () => {
  it("shows the sanitized upstream reason on a failed request", () => {
    renderSection([
      requestItem({
        request_id: "r1",
        status: "failed",
        output_tokens: 0,
        failure_class: "provider_internal",
        error_message: "Anthropic returned a 529 overloaded error."
      })
    ]);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Anthropic returned a 529 overloaded error.")).toBeInTheDocument();
  });

  it("explains an incomplete request even with no upstream message", () => {
    // WMO exposes no finer finish reason than the status, so the log explains
    // the terminal state itself instead of leaving the row without a reason.
    renderSection([
      requestItem({ request_id: "r1", status: "incomplete", error_message: null })
    ]);
    expect(screen.getByText("Incomplete")).toBeInTheDocument();
    expect(screen.getByText(/ended before completion/)).toBeInTheDocument();
  });
});
