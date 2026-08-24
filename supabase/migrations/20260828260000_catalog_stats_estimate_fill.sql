-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Estimate-fill every missing catalog serving stat (uptime, tok/s, latency) so
-- no provider row renders a blank cell (the product owner r2: "fill tok/s + the rest").
--
-- Production never runs the seed, so the seed's section-10d fill (same values)
-- only covers seeded environments; this migration applies the identical
-- idempotent fill to the live catalog. Conservative placeholders, not measured
-- numbers: 99.0% uptime, 60 tok/s, 900 ms p50 latency. A row with NO stats at
-- all is stamped stats_source='estimate' (requires 20260828240000's widened
-- check); a row that already carried OpenRouter-seeded stats keeps that label —
-- both read as "estimated" in the UI. The observed overlay
-- (gateway_observed_model_stats) still replaces all three with measured values
-- once a route clears the sample floor, so the estimate->measured flip is
-- untouched. Re-running finds no null stats and is a no-op.

update public.model_providers mp set
  uptime_30d = coalesce(mp.uptime_30d, 99.0),
  throughput_tps = coalesce(mp.throughput_tps, 60.0),
  latency_p50_ms = coalesce(mp.latency_p50_ms, 900.0),
  stats_source = coalesce(mp.stats_source, 'estimate')
where mp.owning_org_id is null
  and (mp.uptime_30d is null or mp.throughput_tps is null or mp.latency_p50_ms is null);
