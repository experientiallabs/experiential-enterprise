// Metadata provenance: is a route's price / stats an ESTIMATE (seeded, or from
// a third-party listing) or MEASURED from our own serving? Every catalog stat
// carries a source field so the UI can say which, and so a field can later FLIP
// from estimate to measured once we've served enough volume to trust our own
// numbers.
//
// The flip mechanism (two independent tracks, same shape — keep the estimate,
// prefer measured once volume clears a threshold):
//
//  * STATS (uptime / throughput / latency): seeded values carry
//    `stats_source = 'openrouter'`. The API overlays observed values from the
//    gateway usage ledger (explabs/api/routes/model_stats.py) per
//    (alias, provider) route once it has >= MIN_OBSERVED_SAMPLE terminal events
//    in the trailing window, stamping `stats_source = 'observed'`. Below the
//    floor the seeded value stands. This overlay IS the estimate->measured flip
//    for stats, already live.
//
//  * PRICING: seeded prices carry `pricing_source` = a real source
//    ('openrouter', 'provider-docs', 'aws-price-list') or, where a value had to
//    be guessed, `'estimate'`. An estimated price is DISPLAY-ONLY and is never
//    billed or served: the gateway's servability gate and the catalog sync only
//    activate a host-managed route on an authoritative price (AGENTS.md "never
//    invent a price"). The forward path is a future `'measured'` source derived
//    from settled per-token cost once per-provider (then per-model) volume
//    clears a threshold, preferred over the estimate the same way observed stats
//    are preferred today.

import type { CatalogDeployment } from "./types";

/** Pricing source labeled an explicit estimate (guessed, not from a real source). */
export function isEstimatedPricing(deployment: CatalogDeployment): boolean {
  return deployment.pricing_source === "estimate";
}

/** Stats measured from our own serving (the flip landed for this route). */
export function isMeasuredStats(deployment: CatalogDeployment): boolean {
  return deployment.stats_source === "observed";
}

/** Stats still seeded/estimated from a third-party listing, not yet measured. */
export function isEstimatedStats(deployment: CatalogDeployment): boolean {
  return deployment.stats_source !== "observed" && deployment.stats_source !== null;
}

/** Human label for where a route's stats come from; null when unknown. */
export function statsSourceLabel(deployment: CatalogDeployment): string | null {
  switch (deployment.stats_source) {
    case "observed":
      return "Measured from Experiential serving";
    case "openrouter":
      return "Estimated from OpenRouter listings";
    case "estimate":
      return "Estimated (not yet measured)";
    case null:
      return null;
  }
}
