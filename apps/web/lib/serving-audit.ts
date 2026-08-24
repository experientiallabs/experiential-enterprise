import { formatRequestCostUsd } from "@/lib/money";
import type { ServingRequestStatus } from "./types";

// The per-call routing audit: what the serving runtime decided for one request
// and why. Platform-operator surface only. Telemetry stays routing-opaque for
// tenants (it sells an "optimized" endpoint and never describes a router), so
// the backend serves this from a separate admin-gated route and nothing here is
// reachable from a tenant session. The playground inspector is the one tenant
// read that names the routed model and cluster label, deliberately and with a
// product ruling pending; it has its own types under lib/endpoints/.
//
// Payloads come through the parser below rather than a cast, for the same
// reason the runs panel parses: `cost` columns are Postgres `numeric` and
// arrive as decimal strings often enough that arithmetic on an unvalidated
// field silently concatenates.

/**
 * D-METERING legs, mirroring the column's CHECK and wmh's own Literal so the
 * parser can reject an uncategorized one. Only "serving" has a producer today;
 * the internal panel renders the raw token rather than carrying display names
 * for three values nothing can currently write.
 */
export const SERVING_LEGS = ["serving", "optimization", "eval", "overhead"] as const;

export type ServingLeg = (typeof SERVING_LEGS)[number];

/**
 * wmh's reason string for a call that died before any policy ran (an unset
 * api_key_env, a failing embed call). Such a row carries no cluster, an empty
 * model, and a defaulted 0.0 router cost, none of which describe a decision —
 * so the panel must branch on this rather than render those as facts. Pinned
 * here and asserted in serving-audit.test.ts; wmh writes the same literal in
 * serving/chat.py.
 */
export const ERROR_BEFORE_ROUTING = "error-before-routing";

/** True when routing never happened, so none of the decision fields mean anything. */
export function routingFailedBeforePolicy(audit: ServingRoutingAudit): boolean {
  return audit.routing_reason === ERROR_BEFORE_ROUTING;
}

/**
 * One served call's decision, beside the outcome to read it against. Every
 * mechanism field is nullable: a static policy activates no cluster and a
 * pre-audit row reports no reason, and both must read as absent rather than as
 * a cluster named "" or a reason nobody gave.
 */
export type ServingRoutingAudit = {
  id: string;
  org_id: string;
  endpoint_id: string;
  endpoint_label: string;
  /** Pool entry the policy chose. */
  model: string | null;
  /** Provider runtime id behind that pool entry. */
  provider_model: string | null;
  cluster_id: string | null;
  cluster_label: string | null;
  routing_reason: string | null;
  /** The routing decision's own cost. Null means a pre-audit row; 0 is a free policy. */
  router_cost_usd: number | null;
  leg: ServingLeg;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number | null;
  latency_ms: number | null;
  ttfb_ms: number | null;
  status: ServingRequestStatus;
  error_message: string | null;
  created_at: string;
};

/** The audited call plus the tenant it belongs to, resolved to a name. */
export type ServingRoutingAuditPayload = {
  request: ServingRoutingAudit;
  /** Null when the org row is gone; the request still carries its `org_id`. */
  org: { id: string; name: string; slug: string } | null;
};

/**
 * What a null `router_cost_usd` means. The serving path always reports this
 * figure, so a null is a row written before the column existed, NOT a policy
 * that declined to say. It is an absence either way, never a zero.
 */
export const ROUTER_COST_NOT_RECORDED = "not recorded";

/**
 * The routing decision's own cost. A real zero is kept as "$0.00" and only a
 * missing value reads as not recorded: a free policy costing nothing to
 * evaluate is a measurement, and collapsing the two would hide whether the
 * router is instrumented at all.
 */
export function formatRouterCostUsd(value: number | null): string {
  return value === null ? ROUTER_COST_NOT_RECORDED : formatRequestCostUsd(value);
}

/** What a call with no cluster reads as. A static policy has no clusters. */
/**
 * The activated cluster, named and identified, or null when the policy that
 * served this call does not route by cluster.
 *
 * Null is the COMMON case, not an edge one, and the caller must render nothing
 * rather than an absence: only cluster-routing policies set these columns
 * (`rank_decision` on the pinned engine), while a static policy and a sticky
 * affinity hit — which is every endpoint the platform creates today — leave
 * both empty. "No cluster activated" would read as a fact about the routing
 * when it is only a fact about which family of policy ran.
 *
 * The label is what an operator recognizes and the id is what reproduces the
 * decision, so both show whenever both exist. An empty label is treated as
 * absent: the write path nulls it, and a blank would render as a cluster whose
 * name is nothing.
 */
export function activatedCluster(audit: ServingRoutingAudit): string | null {
  const label = audit.cluster_label === null || audit.cluster_label === "" ? null : audit.cluster_label;
  if (audit.cluster_id === null && label === null) {
    return null;
  }
  if (label === null) {
    return `Cluster ${audit.cluster_id}`;
  }
  if (audit.cluster_id === null) {
    return label;
  }
  return `${label} (cluster ${audit.cluster_id})`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function countOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAudit(raw: unknown): ServingRoutingAudit | null {
  const source = recordOrNull(raw);
  if (source === null) {
    return null;
  }
  const status = source.status === "ok" || source.status === "error" ? source.status : null;
  const leg = SERVING_LEGS.find((entry) => entry === source.leg) ?? null;
  // Identity, leg and status are NOT NULL in the ledger and the backend
  // serializes every declared field, so a missing one means the payload is not
  // an audit row. Failing here beats rendering a decision panel with blanks
  // where the decision should be.
  if (
    typeof source.id !== "string" ||
    typeof source.org_id !== "string" ||
    typeof source.endpoint_id !== "string" ||
    typeof source.endpoint_label !== "string" ||
    typeof source.created_at !== "string" ||
    status === null ||
    leg === null
  ) {
    return null;
  }
  return {
    cached_tokens: countOrZero(source.cached_tokens),
    cluster_id: stringOrNull(source.cluster_id),
    cluster_label: stringOrNull(source.cluster_label),
    cost_usd: numberOrNull(source.cost_usd),
    created_at: source.created_at,
    endpoint_id: source.endpoint_id,
    endpoint_label: source.endpoint_label,
    error_message: stringOrNull(source.error_message),
    id: source.id,
    input_tokens: countOrZero(source.input_tokens),
    latency_ms: numberOrNull(source.latency_ms),
    leg,
    model: stringOrNull(source.model),
    org_id: source.org_id,
    output_tokens: countOrZero(source.output_tokens),
    provider_model: stringOrNull(source.provider_model),
    router_cost_usd: numberOrNull(source.router_cost_usd),
    routing_reason: stringOrNull(source.routing_reason),
    status,
    ttfb_ms: numberOrNull(source.ttfb_ms)
  };
}

function parseOrg(raw: unknown): ServingRoutingAuditPayload["org"] {
  const source = recordOrNull(raw);
  if (
    source === null ||
    typeof source.id !== "string" ||
    typeof source.name !== "string" ||
    typeof source.slug !== "string"
  ) {
    // Tolerant where the audit row is strict: a missing org name is a header
    // label the panel can do without, not a reason to hide the decision.
    return null;
  }
  return { id: source.id, name: source.name, slug: source.slug };
}

export function parseServingRoutingAudit(raw: unknown): ServingRoutingAuditPayload | null {
  const source = recordOrNull(raw);
  if (source === null) {
    return null;
  }
  const request = parseAudit(source.request);
  if (request === null) {
    return null;
  }
  return { org: parseOrg(source.org), request };
}

/**
 * Read one call's routing decision. Only ever called from an operator view:
 * the proxy answers 404 for everyone else, and the Telemetry page does not
 * render the section that calls this unless the viewer is a platform admin, so
 * a tenant session issues no request at all.
 */
export async function fetchServingRoutingAudit(
  requestId: string
): Promise<ServingRoutingAuditPayload> {
  // Written out rather than routed through lib/routes: this is an /api proxy,
  // not a navigable page, and the backend data source spells the same path.
  const response = await fetch(`/api/admin/serving-requests/${encodeURIComponent(requestId)}`, {
    cache: "no-store"
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Failed to load the routing decision (HTTP ${response.status})`
    );
  }
  const parsed = parseServingRoutingAudit(await response.json().catch(() => null));
  if (parsed === null) {
    throw new Error("The routing audit returned an unreadable payload.");
  }
  return parsed;
}
