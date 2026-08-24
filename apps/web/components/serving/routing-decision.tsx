"use client";

import { formatRequestCostUsd } from "@/lib/money";
import { formatTokensInOut } from "@/components/playground/usage-model";
import { Shimmer } from "@/components/ui/Shimmer";
import {
  activatedCluster,
  formatRouterCostUsd,
  routingFailedBeforePolicy,
  type ServingRoutingAuditPayload
} from "@/lib/serving-audit";
import { formatLatencyMs } from "@/lib/serving-telemetry";

// The operator half of an expanded Telemetry row: why this call went where it
// went. Rendered only for platform admins, and only ever handed an audit the
// admin-gated proxy returned, so this component has no gate of its own - the
// Telemetry page decides, server-side, whether it exists at all.
//
// Internal copy, so it names the mechanism plainly ("routing", "cluster"). The
// tenant-facing half of the same row must never do that.
//
// The section is built around the two facts every policy reports: WHICH model
// was chosen, and the reason string explaining WHY. The reason is the audit -
// it is the only field that carries a policy's actual evidence, and it is
// rendered verbatim and never parsed into structured fields, because inventing
// structure from prose reads as more certain than the prose is. Cluster is
// NOT a fact about routing in general: only cluster-routing policies set it,
// so it appears when present and is silent otherwise.

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** What an absent value reads as. Never a blank cell, never a zero. */
const NOT_RECORDED = "not recorded";

export function RoutingDecision({
  audit,
  error
}: {
  audit: ServingRoutingAuditPayload | undefined;
  error: string | null;
}) {
  if (error !== null) {
    return (
      <p className="m-0 mt-2 text-[11px] text-danger">Routing decision unavailable: {error}</p>
    );
  }
  if (audit === undefined) {
    return <Shimmer className="mt-2 h-[92px] rounded-md" />;
  }
  const call = audit.request;
  // A call that died before any policy ran carries an empty model and a
  // defaulted 0.0 router cost. Reading those as a decision states two things
  // that are false — that a model was chosen, and that choosing it cost
  // nothing — on exactly the row class an operator opens this panel for. So
  // that row gets its own reading, and it wins over everything below.
  const failedBeforeRouting = routingFailedBeforePolicy(call);
  const cluster = activatedCluster(call);
  return (
    // Brand accent, not purple (the product owner, 2026-07-30): the operator panel is
    // still part of the product's one palette.
    <section className="mt-2 rounded-[var(--radius-md)] border border-accent bg-accent-soft px-3 py-2.5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 text-[10px] font-semibold uppercase tracking-wide text-accent">
          Routing decision
        </h3>
        <span className="text-[10px] text-muted">
          Internal view. {audit.org === null ? call.org_id : audit.org.name} ·{" "}
          {call.endpoint_label}
        </span>
      </header>
      {failedBeforeRouting ? (
        <div className="mt-2">
          <p className="m-0 text-[12px] font-medium text-ink">
            Routing failed before a policy ran, so this call has no decision to audit.
          </p>
          <p className="m-0 mt-1 text-[11px] leading-relaxed text-muted">
            No model was chosen. The endpoint could not set up routing or its provider, so the
            caller got a 502 and the request id here was minted server-side rather than returned
            to them.
          </p>
          {/* The leg is metering context every audit row carries, decision or not: a failed
              call was still billed to some leg, and an operator reconciling spend needs it
              here as much as on a successful one. */}
          <dl className="m-0 mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
            <Fact label="Metered leg" value={call.leg} />
          </dl>
        </div>
      ) : (
        <>
          <div className="mt-2">
            <Label>Model chosen</Label>
            <p className="m-0 mt-0.5 text-[14px] font-semibold text-ink">
              {call.model ?? NOT_RECORDED}
            </p>
            <p className="m-0 mt-0.5 break-all font-mono text-[11px] text-muted">
              {call.provider_model ?? NOT_RECORDED}
            </p>
          </div>
          <div className="mt-2.5">
            <Label>Why this model</Label>
            {/* Verbatim. A policy's reason string is the only place its actual
                evidence appears, and it is prose the panel must not pretend to
                have parsed. */}
            <p className="m-0 mt-0.5 text-[12px] leading-relaxed text-ink">
              {call.routing_reason ?? NOT_RECORDED}
            </p>
          </div>
          <dl className="m-0 mt-2.5 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {/* Only cluster-routing policies report a cluster, so this row is
                absent rather than negative for every other policy. */}
            {cluster !== null && <Fact label="Cluster matched (cluster routing)" value={cluster} />}
            <Fact label="Router cost" value={formatRouterCostUsd(call.router_cost_usd)} />
            <Fact label="Metered leg" value={call.leg} />
          </dl>
        </>
      )}
      <p className="m-0 mt-2 text-[11px] text-muted">
        {formatTokensInOut(call.input_tokens, call.output_tokens)} tokens
        {call.cached_tokens > 0 && ` (${COUNT_FORMAT.format(call.cached_tokens)} cached)`} ·{" "}
        {formatRequestCostUsd(call.cost_usd)} · {formatLatencyMs(call.latency_ms)}
        {call.ttfb_ms !== null && ` (first byte ${formatLatencyMs(call.ttfb_ms)})`} ·{" "}
        {call.status === "error" ? (call.error_message ?? "error") : "ok"}
      </p>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-2">
      {children}
    </span>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="m-0">
        <Label>{label}</Label>
      </dt>
      <dd
        className={
          mono
            ? "m-0 mt-0.5 break-all font-mono text-[11px] text-ink"
            : "m-0 mt-0.5 text-[12px] text-ink"
        }
      >
        {value}
      </dd>
    </div>
  );
}
