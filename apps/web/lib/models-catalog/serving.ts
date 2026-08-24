// Serving truth: which lane actually serves a route, derived from the
// authoritative `billing_source` on each deployment (mirrors
// model_providers.billing_source). Before this, every catalog surface inferred
// "uses Experiential credits" from `owning_org_id === null`, which is wrong: a
// PUBLIC deployment can be BYOK (`customer_managed`) — discovered on
// Fireworks/Bedrock/Azure and listed for everyone, but only callable with the
// caller's own provider key. Reading `billing_source` instead makes the UI
// match what the platform truly serves.
//
// The rule (locked with the backend, AGENTS.md "Two lanes" boundary): a model
// is "use through Experiential" — the default, billed to platform credits —
// ONLY when it has an ACTIVE, PUBLIC, host-managed deployment. Everything else
// requires the user to add a key or connection first, and the request path
// fails closed until they do.

import type { CatalogDeployment, CatalogEntry } from "./types";

/** The lane a single route is actually served through. */
export type ServingLane = "experiential" | "byok" | "local";

/**
 * True when this route serves through Experiential on platform credits: an
 * active, public, host-managed deployment. `owning_org_id === null` alone is
 * NOT sufficient — a public `customer_managed` row is a BYOK route the platform
 * lists but does not fund.
 */
export function isHostServed(deployment: CatalogDeployment): boolean {
  return (
    deployment.billing_source === "host_managed" &&
    deployment.status === "active" &&
    deployment.owning_org_id === null
  );
}

/**
 * Pin experiential_cloud first; keep the incoming order for every other
 * provider. Display order only — does not add a route or rewrite a
 * tenant-authored waterfall.
 */
export function pinExperientialCloudFirst<T extends { provider: string }>(
  providers: readonly T[]
): T[] {
  const leading = providers.filter((row) => row.provider === "experiential_cloud");
  if (leading.length === 0) {
    return [...providers];
  }
  return [...leading, ...providers.filter((row) => row.provider !== "experiential_cloud")];
}

/** The serving lane for one route: what the row should say about reaching it. */
export function servingLane(deployment: CatalogDeployment): ServingLane {
  if (isHostServed(deployment)) {
    return "experiential";
  }
  if (deployment.provider === "local") {
    return "local";
  }
  // A public or org BYOK route (customer_managed), or a disabled host route:
  // the caller funds it with their own provider key.
  return "byok";
}

/**
 * True when the model can be used through Experiential on platform credits —
 * any of its routes is host-served. When false, the model is BYOK-only (or
 * self-hosted) and the detail page/playground must not imply it "just works".
 */
export function servedThroughExperiential(providers: CatalogDeployment[]): boolean {
  return providers.some(isHostServed);
}

/**
 * True when the model is reachable ONLY by bringing your own key/connection:
 * it has at least one route, but none is host-served. This is the majority of
 * the catalog — the state the UI previously hid behind a false "uses credits".
 */
export function requiresOwnKey(entry: CatalogEntry): boolean {
  return entry.providers.length > 0 && !servedThroughExperiential(entry.providers);
}
