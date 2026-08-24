import { fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/logs",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { LoginModalProvider } from "@/components/auth/login-modal-context";
import { TelemetryView } from "@/components/telemetry-page/telemetry-view";

// Telemetry is a signed-in surface; mount the login-modal host it gates through.
function render(ui: Parameters<typeof renderBare>[0]) {
  return renderBare(<LoginModalProvider isAuthenticated>{ui}</LoginModalProvider>);
}
import { DEFAULT_TELEMETRY_VIEW } from "@/lib/gateway-telemetry";
import type { UsageByKey, UsageByProvider, UsageRequestItem, UsageTimeseries } from "@/lib/types";

const TIMESERIES: UsageTimeseries = {
  window: "7d",
  bucket_seconds: 86_400,
  buckets: [
    {
      bucket_start: "2026-08-17T00:00:00+00:00",
      model: "gpt-5",
      lane: "platform",
      request_count: 10,
      error_count: 2,
      input_tokens: 1000,
      output_tokens: 200,
      cost_usd: 0.5,
      estimated_cost_usd: 0
    },
    {
      bucket_start: "2026-08-17T00:00:00+00:00",
      model: "claude-fable-5",
      lane: "byok",
      request_count: 4,
      error_count: 0,
      input_tokens: 400,
      output_tokens: 100,
      cost_usd: 0,
      estimated_cost_usd: 2.25
    }
  ]
};

const BY_PROVIDER: UsageByProvider = {
  window: "7d",
  providers: [
    {
      provider: "openai",
      request_count: 10,
      error_count: 2,
      input_tokens: 1000,
      output_tokens: 200,
      cost_usd: 0.5,
      estimated_cost_usd: 0,
      last_used_at: "2026-08-18T09:00:00+00:00"
    },
    {
      provider: null,
      request_count: 1,
      error_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      estimated_cost_usd: 0,
      last_used_at: "2026-08-17T08:00:00+00:00"
    }
  ]
};

const BY_KEY: UsageByKey = {
  window: "7d",
  keys: [
    {
      api_key_id: "aaaa0000-0000-4000-8000-000000000001",
      key_label: "prod-agent",
      models: [
        {
          model: "gpt-5",
          request_count: 10,
          error_count: 2,
          input_tokens: 1000,
          output_tokens: 200,
          cost_usd: 0.5,
          estimated_cost_usd: 0
        }
      ],
      totals: {
        request_count: 10,
        error_count: 2,
        input_tokens: 1000,
        output_tokens: 200,
        cost_usd: 0.5,
        estimated_cost_usd: 0
      },
      last_used_at: "2026-08-17T10:00:00+00:00"
    },
    {
      // Hard-deleted before settlement: attribution is gone entirely.
      api_key_id: null,
      key_label: null,
      models: [
        {
          model: "claude-fable-5",
          request_count: 4,
          error_count: 0,
          input_tokens: 400,
          output_tokens: 100,
          cost_usd: 0,
          estimated_cost_usd: 2.25
        }
      ],
      totals: {
        request_count: 4,
        error_count: 0,
        input_tokens: 400,
        output_tokens: 100,
        cost_usd: 0,
        estimated_cost_usd: 2.25
      },
      last_used_at: "2026-08-16T10:00:00+00:00"
    }
  ]
};

const REQUESTS: UsageRequestItem[] = [
  {
    request_id: "req-1",
    model: "gpt-5",
    provider: "openai",
    lane: "platform",
    api_key_id: "aaaa0000-0000-4000-8000-000000000001",
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
    ttft_ms: 120,
    status: "completed",
    attempt_count: 1,
    created_at: "2026-08-17T10:00:00+00:00",
    tools_used: [],
    failure_class: null,
    error_message: null,
    prompt_group: null,
    conversation_group: null
  },
  {
    // BYOK: cost attributed but never charged — must render labeled as an
    // estimate, never as billed money.
    request_id: "req-2",
    model: "claude-fable-5",
    provider: "anthropic",
    lane: "byok",
    api_key_id: null,
    key_label: null,
    input_tokens: 400,
    output_tokens: 100,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    estimated_cost_usd: 0.75,
    real_cost_usd: 0.75,
    pricing_known: true,
    latency_ms: 900,
    ttft_ms: 240,
    status: "completed",
    attempt_count: 2,
    created_at: "2026-08-17T09:00:00+00:00",
    tools_used: [],
    failure_class: null,
    error_message: null,
    prompt_group: null,
    conversation_group: null
  },
  {
    // Failed before dispatch: no lane, no provider, no dollars.
    request_id: "req-3",
    model: "gpt-5",
    provider: null,
    lane: null,
    api_key_id: "aaaa0000-0000-4000-8000-000000000001",
    key_label: "prod-agent",
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    estimated_cost_usd: 0,
    real_cost_usd: 0,
    pricing_known: true,
    latency_ms: null,
    ttft_ms: null,
    status: "expired_before_dispatch",
    attempt_count: 0,
    created_at: "2026-08-17T08:00:00+00:00",
    tools_used: [],
    failure_class: null,
    error_message: "The request expired before it could reach a provider.",
    prompt_group: null,
    conversation_group: null
  }
];

function renderView() {
  return render(
    <TelemetryView
      firstCall={null}
      initialByKey={BY_KEY}
      initialByProvider={BY_PROVIDER}
      initialCursor={null}
      initialRequests={REQUESTS}
      initialTimeseries={TIMESERIES}
      initialView={DEFAULT_TELEMETRY_VIEW}
      nowMs={Date.parse("2026-08-18T12:00:00Z")}
      orgId="org1"
    />
  );
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/usage/timeseries")
      ? TIMESERIES
      : url.includes("/usage/by-key")
        ? BY_KEY
        : url.includes("/usage/by-provider")
          ? BY_PROVIDER
          : { requests: REQUESTS, next_cursor: null };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Telemetry page body", () => {
  it("renders every section off one dataset, without the retired vocabulary", () => {
    stubFetch();
    renderView();

    // One Usage card fronts both breakdowns behind a toggle; the request log
    // is now "Request history". Suggestions no longer render here.
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "By agent" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Request history" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Suggestions" })).toBeNull();
    // "Session" is a retired billing unit here; the log is "Request history".
    expect(screen.queryByText(/session/i)).toBeNull();

    // The headline is all-spend with the never-charged split visible.
    expect(screen.getByText("$2.75")).toBeInTheDocument();
    expect(screen.getByText("of which $2.25 est. pass-through")).toBeInTheDocument();
  });

  it("names the ledger's null cases and offers no row expander", () => {
    stubFetch();
    renderView();

    // Request history (always visible) names the null cases verbatim.
    expect(screen.getByText("(undispatched)")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    // The BYOK row's money is labeled an estimate.
    expect(screen.getByText("$0.750")).toBeInTheDocument();
    expect(screen.getAllByText("est.").length).toBeGreaterThan(0);
    // The ledger is content-free: each row is complete, nothing expands.
    expect(screen.queryByLabelText("Expand request")).toBeNull();

    // The by-agent breakdown groups a key deleted before settlement as
    // "(deleted key)"; it lives behind the Usage toggle.
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    expect(screen.getAllByText("(deleted key)").length).toBeGreaterThan(0);
  });

  it("breaks usage down by platform behind the third toggle", () => {
    stubFetch();
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "By platform" }));
    // Provider labels are the customer-facing names, biggest spend first. The
    // provider now also labels each row in the request log's Provider column, so
    // the name appears in more than one place on the page.
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    // The nothing-was-dispatched group surfaces honestly instead of vanishing.
    expect(screen.getByText("Not dispatched")).toBeInTheDocument();
    // 2 errors out of 10 requests on the OpenAI row.
    expect(screen.getByText("20.0%")).toBeInTheDocument();
  });

  it("drives every read from the model filter", async () => {
    const fetchMock = stubFetch();
    renderView();

    fireEvent.change(screen.getByLabelText("Filter by model"), {
      target: { value: "gpt-5" }
    });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/usage/timeseries") && url.includes("model=gpt-5"))).toBe(true);
      expect(urls.some((url) => url.includes("/usage/requests") && url.includes("model=gpt-5"))).toBe(true);
      expect(urls.some((url) => url.includes("/usage/by-key"))).toBe(true);
      expect(urls.some((url) => url.includes("/usage/by-provider"))).toBe(true);
    });
  });

  it("applies a model as the global filter from its table row", async () => {
    const fetchMock = stubFetch();
    renderView();

    fireEvent.click(screen.getByRole("button", { name: /claude-fable-5/ }));

    expect(screen.getByLabelText("Filter by model")).toHaveValue("claude-fable-5");
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(
        urls.some((url) => url.includes("/usage/requests") && url.includes("model=claude-fable-5"))
      ).toBe(true);
    });
  });

  it("toggles the errors-only request log from the requests tile", async () => {
    const fetchMock = stubFetch();
    renderView();

    fireEvent.click(screen.getByRole("button", { name: /Requests.*errors/ }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(
        urls.some((url) => url.includes("/usage/requests") && url.includes("status=error"))
      ).toBe(true);
    });
  });
});
