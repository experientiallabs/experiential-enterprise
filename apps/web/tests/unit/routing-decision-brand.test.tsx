import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RoutingDecision } from "@/components/serving/routing-decision";
import type { ServingRoutingAuditPayload } from "@/lib/serving-audit";

// The routing panel renders in the brand's accent family, not purple (the product owner,
// 2026-07-30): the operator view is still part of the product's one palette.
const AUDIT = {
  org: { id: "org1", name: "Demo", slug: "demo" },
  request: {
    id: "req-1",
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
    cached_tokens: 0,
    cost_usd: 0.003,
    latency_ms: 310,
    ttfb_ms: 90,
    status: "ok",
    error_message: null,
    created_at: "2026-07-27T10:00:00Z"
  }
} as unknown as ServingRoutingAuditPayload;

describe("RoutingDecision palette", () => {
  it("uses the brand accent family, never purple", () => {
    const { container } = render(<RoutingDecision audit={AUDIT} error={null} />);

    const section = container.querySelector("section");
    expect(section?.className).toContain("border-accent");
    expect(section?.className).toContain("bg-accent-soft");
    expect(container.innerHTML).not.toContain("purple");
  });
});
