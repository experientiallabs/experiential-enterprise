import { describe, expect, it } from "vitest";

import {
  ERROR_BEFORE_ROUTING,
  ROUTER_COST_NOT_RECORDED,
  activatedCluster,
  formatRouterCostUsd,
  parseServingRoutingAudit,
  routingFailedBeforePolicy,
  type ServingRoutingAudit
} from "@/lib/serving-audit";

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    org: { id: "org1", name: "Demo", slug: "demo" },
    request: {
      id: "req1",
      org_id: "org1",
      endpoint_id: "ep1",
      endpoint_label: "support-prod",
      model: "claude-haiku-4-5",
      provider_model: "us.anthropic.claude-haiku-4-5-v1:0",
      cluster_id: "3",
      cluster_label: "billing-questions",
      routing_reason: "cluster 3 takes the cheapest model above the quality floor",
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
      created_at: "2026-07-27T10:00:00Z",
      ...overrides
    }
  };
}

function audit(overrides: Partial<ServingRoutingAudit> = {}): ServingRoutingAudit {
  const parsed = parseServingRoutingAudit(payload());
  if (parsed === null) {
    throw new Error("fixture must parse");
  }
  return { ...parsed.request, ...overrides };
}

describe("parseServingRoutingAudit", () => {
  it("reads the whole decision and its tenant", () => {
    const parsed = parseServingRoutingAudit(payload());

    expect(parsed?.request.cluster_label).toBe("billing-questions");
    expect(parsed?.request.provider_model).toBe("us.anthropic.claude-haiku-4-5-v1:0");
    expect(parsed?.request.leg).toBe("serving");
    expect(parsed?.org).toEqual({ id: "org1", name: "Demo", slug: "demo" });
  });

  it("coerces the numeric columns Postgres hands back as decimal strings", () => {
    // A concatenated string here is the failure this parser exists to prevent.
    const parsed = parseServingRoutingAudit(
      payload({ cost_usd: "0.003", router_cost_usd: "0.0000021", latency_ms: "310" })
    );

    expect(parsed?.request.cost_usd).toBe(0.003);
    expect(parsed?.request.router_cost_usd).toBe(0.0000021);
    expect(parsed?.request.latency_ms).toBe(310);
  });

  it("keeps an unrecorded field absent instead of substituting a zero", () => {
    const parsed = parseServingRoutingAudit(
      payload({ router_cost_usd: null, routing_reason: null, cluster_id: null, cluster_label: null })
    );

    expect(parsed?.request.router_cost_usd).toBeNull();
    expect(parsed?.request.routing_reason).toBeNull();
    expect(parsed?.request.cluster_id).toBeNull();
  });

  it("rejects a payload whose leg or identity is missing", () => {
    // A blank decision panel would read as "the router did nothing", so an
    // unreadable payload has to fail rather than render.
    expect(parseServingRoutingAudit(payload({ leg: "training" }))).toBeNull();
    expect(parseServingRoutingAudit(payload({ id: 7 }))).toBeNull();
    expect(parseServingRoutingAudit(payload({ status: "pending" }))).toBeNull();
    expect(parseServingRoutingAudit({ request: null })).toBeNull();
    expect(parseServingRoutingAudit(null)).toBeNull();
  });

  it("survives a missing org, which is only a header label", () => {
    const parsed = parseServingRoutingAudit({ ...(payload() as object), org: null });

    expect(parsed).not.toBeNull();
    expect(parsed?.org).toBeNull();
  });
});

describe("activatedCluster", () => {
  it("names and identifies the cluster when a cluster-routing policy served the call", () => {
    expect(activatedCluster(audit())).toBe("billing-questions (cluster 3)");
  });

  it("falls back to whichever half exists", () => {
    expect(activatedCluster(audit({ cluster_label: null }))).toBe("Cluster 3");
    expect(activatedCluster(audit({ cluster_id: null }))).toBe("billing-questions");
  });

  // Null, not a sentence. Only cluster-routing policies set these columns; a
  // static policy and a sticky affinity hit leave both empty, and that is the
  // shape of every endpoint the platform creates today. A rendered "no cluster"
  // would read as a fact about the routing instead of a fact about which family
  // of policy ran.
  it("is null when the policy does not route by cluster", () => {
    expect(activatedCluster(audit({ cluster_id: null, cluster_label: null }))).toBeNull();
  });

  it("treats an empty label with no id as absent, not as a nameless cluster", () => {
    expect(activatedCluster(audit({ cluster_id: null, cluster_label: "" }))).toBeNull();
  });
});

describe("formatRouterCostUsd", () => {
  it("distinguishes a free policy from a row that predates the column", () => {
    // The null-over-zero rule: "$0.00" is a measurement of a free policy, and a
    // null is a row written before the column existed. The serving path always
    // reports the figure, so those are the only two readings.
    expect(formatRouterCostUsd(0)).toBe("$0.00");
    expect(formatRouterCostUsd(null)).toBe(ROUTER_COST_NOT_RECORDED);
    expect(formatRouterCostUsd(0.0000021)).toBe("$0.000002");
  });
});

describe("routingFailedBeforePolicy", () => {
  // Pins the literal wmh writes in serving/chat.py. If that string changes, the
  // panel silently goes back to reporting a $0.00 free policy on a call where
  // no policy ran, so the coupling is asserted rather than assumed.
  it("recognizes wmh's pre-routing failure reason", () => {
    expect(ERROR_BEFORE_ROUTING).toBe("error-before-routing");
    expect(routingFailedBeforePolicy(audit({ routing_reason: ERROR_BEFORE_ROUTING }))).toBe(true);
  });

  it("treats a real reason, and an unrecorded one, as a decision that happened", () => {
    expect(routingFailedBeforePolicy(audit())).toBe(false);
    expect(routingFailedBeforePolicy(audit({ routing_reason: null }))).toBe(false);
  });
});
