import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServingRequestsView } from "@/components/serving/serving-requests-view";
import { DEFAULT_SERVING_VIEW } from "@/lib/serving-telemetry";
import type { ServingRequest, ServingSummary } from "@/lib/types";

const REQUEST_ID = "aaaa0000-0000-4000-8000-000000000001";
const AUDIT_URL = `/api/admin/serving-requests/${REQUEST_ID}`;

const SUMMARY: ServingSummary = {
  window: "7d",
  bucket_seconds: 86_400,
  stats: {
    request_count: 1,
    error_count: 0,
    unpriced_count: 0,
    cost_usd_total: 0.003,
    input_tokens_total: 1200,
    output_tokens_total: 300,
    cached_tokens_total: 400,
    latency_p50_ms: 310,
    latency_p95_ms: 310
  },
  buckets: [],
  endpoints: [
    {
      endpoint_id: "ep1",
      endpoint_label: "support-prod",
      request_count: 1,
      last_at: "2026-07-27T10:00:00Z"
    }
  ]
};

const REQUESTS: ServingRequest[] = [
  {
    id: REQUEST_ID,
    endpoint_id: "ep1",
    endpoint_label: "support-prod",
    input_tokens: 1200,
    output_tokens: 300,
    cached_tokens: 400,
    cost_usd: 0.003,
    frontier_cost_usd: 0.02,
    latency_ms: 310,
    ttfb_ms: 90,
    status: "ok",
    error_message: null,
    created_at: "2026-07-27T10:00:00Z"
  }
];

// The shape production actually produces: no cluster. Only cluster-routing
// policies fill those columns, and every endpoint the platform creates runs a
// policy that does not. The reason string is the whole audit for such a call.
const AUDIT = {
  org: { id: "org1", name: "Demo", slug: "demo" },
  request: {
    id: REQUEST_ID,
    org_id: "org1",
    endpoint_id: "ep1",
    endpoint_label: "support-prod",
    model: "claude-haiku-4-5",
    provider_model: "us.anthropic.claude-haiku-4-5-v1:0",
    cluster_id: null,
    cluster_label: null,
    routing_reason: "static policy",
    router_cost_usd: 0,
    leg: "serving",
    input_tokens: 1200,
    output_tokens: 300,
    cached_tokens: 400,
    cost_usd: 0.003,
    latency_ms: 310,
    ttfb_ms: 90,
    status: "ok",
    error_message: null,
    created_at: "2026-07-27T10:00:00Z"
  }
};

/** A cluster-routing policy's row, the only shape that reports a cluster. */
const CLUSTER_AUDIT = {
  ...AUDIT,
  request: {
    ...AUDIT.request,
    cluster_id: "3",
    cluster_label: "billing-questions",
    routing_reason: "rank router: nearest cluster 3 (billing-questions)"
  }
};

const TENANT_DETAIL = {
  request: {
    ...REQUESTS[0],
    org_id: "org1",
    request: { messages: [{ role: "user", content: "hi" }] },
    response: { choices: [{ message: { role: "assistant", content: "hello" } }] }
  }
};

function stubFetch(auditBody: unknown = AUDIT): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith("/api/admin/serving-requests") ? auditBody : TENANT_DETAIL;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderView(canAuditRouting: boolean) {
  return render(
    <ServingRequestsView
      canAuditRouting={canAuditRouting}
      initialCursor={null}
      initialRequests={REQUESTS}
      initialSummary={SUMMARY}
      initialView={DEFAULT_SERVING_VIEW}
      lockedEndpointId="ep1"
      nowMs={Date.parse("2026-07-27T10:01:00Z")}
      orgId="org1"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Telemetry row's routing decision", () => {
  it("leads with the model chosen and the reason, on a call with no cluster", async () => {
    stubFetch();
    renderView(true);

    fireEvent.click(screen.getByLabelText("Expand request"));

    expect(await screen.findByText("Routing decision")).toBeInTheDocument();
    expect(screen.getByText("Model chosen")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
    expect(screen.getByText("us.anthropic.claude-haiku-4-5-v1:0")).toBeInTheDocument();
    // The reason IS the audit, rendered verbatim and unparsed.
    expect(screen.getByText("Why this model")).toBeInTheDocument();
    expect(screen.getByText("static policy")).toBeInTheDocument();
    // A free policy's measured zero, not "not recorded".
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("Metered leg")).toBeInTheDocument();
  });

  // The bug this round fixes: the panel used to lead with a cluster field that
  // is structurally null for every call production makes, so it stated an
  // artifact of an inapplicable field as a fact about the routing.
  it("says nothing at all about clusters when the policy does not route by cluster", async () => {
    stubFetch();
    renderView(true);

    fireEvent.click(screen.getByLabelText("Expand request"));

    await screen.findByText("Routing decision");
    expect(screen.queryByText(/cluster/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No cluster/i)).not.toBeInTheDocument();
  });

  it("renders a punctuated reason verbatim rather than parsing it into fields", async () => {
    // The engine's own sticky-affinity reason, colons and all. Reason strings
    // carry punctuation and numbers, and the panel must not split them into
    // pseudo-fields: invented structure reads as more certain than the prose is,
    // and the genuinely structured evidence does not exist on this engine pin.
    const reason = "sticky: conversation affinity";
    stubFetch({ ...AUDIT, request: { ...AUDIT.request, routing_reason: reason } });
    renderView(true);

    fireEvent.click(screen.getByLabelText("Expand request"));

    expect(await screen.findByText(reason)).toBeInTheDocument();
  });

  it("reports the cluster when a cluster-routing policy served the call", async () => {
    stubFetch(CLUSTER_AUDIT);
    renderView(true);

    fireEvent.click(screen.getByLabelText("Expand request"));

    expect(await screen.findByText("Cluster matched (cluster routing)")).toBeInTheDocument();
    expect(screen.getByText("billing-questions (cluster 3)")).toBeInTheDocument();
    expect(
      screen.getByText("rank router: nearest cluster 3 (billing-questions)")
    ).toBeInTheDocument();
  });

  // The gate is server-side, so a tenant does not merely see a hidden section:
  // the request is never issued, and the network tab shows no such route.
  it("renders nothing and issues no audit fetch for a tenant", async () => {
    const fetchMock = stubFetch();
    renderView(false);

    fireEvent.click(screen.getByLabelText("Expand request"));

    // The tenant detail still loads; only the decision is absent.
    await waitFor(() => expect(screen.getByText("Request")).toBeInTheDocument());
    expect(screen.queryByText("Routing decision")).not.toBeInTheDocument();
    expect(screen.queryByText("billing-questions (cluster 3)")).not.toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.startsWith("/api/admin/"))).toBe(false);
    expect(urls).not.toContain(AUDIT_URL);
  });

  it("refuses to describe a decision on a call that failed before routing", async () => {
    // wmh's pre-routing failure row: empty model, no cluster, and a defaulted
    // 0.0 router cost. The fact grid would read as "a free policy chose to
    // route without a cluster", which is two false claims about the row class an
    // operator opens this panel for most often.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const body = String(input).startsWith("/api/admin/serving-requests")
          ? {
              ...CLUSTER_AUDIT,
              request: {
                // Cluster columns deliberately populated: the pre-routing
                // failure branch must win over the cluster row, not race it.
                ...CLUSTER_AUDIT.request,
                model: null,
                provider_model: null,
                routing_reason: "error-before-routing",
                router_cost_usd: 0,
                status: "error",
                error_message: "endpoint setup failed (KeyError)"
              }
            }
          : TENANT_DETAIL;
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" }
        });
      })
    );
    renderView(true);

    fireEvent.click(screen.getByLabelText("Expand request"));

    expect(await screen.findByText(/Routing failed before a policy ran/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("Router cost")).not.toBeInTheDocument();
    expect(screen.queryByText("Why this model")).not.toBeInTheDocument();
    expect(screen.queryByText("Cluster matched (cluster routing)")).not.toBeInTheDocument();
    // Metering context survives a failed decision: the call was still billed to a leg.
    expect(screen.getByText("Metered leg")).toBeInTheDocument();
  });

  it("does not refetch the audit when a row is reopened mid-flight", async () => {
    // Assigned synchronously by the Promise executor below; the no-op initial
    // value keeps it callable without a narrowing dance.
    let resolveAudit: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/admin/serving-requests")) {
        return new Promise<Response>((resolve) => {
          resolveAudit = resolve;
        });
      }
      return new Response(JSON.stringify(TENANT_DETAIL), {
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderView(true);

    // Collapse and reopen before the first audit response lands: the result map
    // is only written on resolve, so nothing but the in-flight set stops this
    // from firing a second identical request.
    fireEvent.click(screen.getByLabelText("Expand request"));
    fireEvent.click(screen.getByLabelText("Collapse request"));
    fireEvent.click(screen.getByLabelText("Expand request"));

    const auditCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/admin/serving-requests")
    );
    expect(auditCalls).toHaveLength(1);

    resolveAudit(
      new Response(JSON.stringify(AUDIT), { headers: { "content-type": "application/json" } })
    );
    expect(await screen.findByText("Routing decision")).toBeInTheDocument();
  });

  it("reports an audit failure without breaking the row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/admin/serving-requests")) {
          return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
        }
        return new Response(JSON.stringify(TENANT_DETAIL), {
          headers: { "content-type": "application/json" }
        });
      })
    );
    renderView(true);

    fireEvent.click(screen.getByLabelText("Expand request"));

    expect(await screen.findByText(/Routing decision unavailable/)).toBeInTheDocument();
    expect(await screen.findByText("Request")).toBeInTheDocument();
  });
});
