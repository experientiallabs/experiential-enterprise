-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Widen model_providers.stats_source to admit 'estimate'.
--
-- Catalog stats (uptime / throughput / latency) came in two flavors: 'openrouter'
-- (seeded from OpenRouter's listings) and 'observed' (measured from our own
-- serving via the gateway_observed_model_stats overlay). Non-OpenRouter provider
-- lanes (native Azure/Bedrock/Fireworks/first-party rows) have no seeded
-- telemetry, so their stats were null. The r3 catalog backfill seeds a
-- reasonable ESTIMATE for those rows so the storefront shows a number instead of
-- a dash, marked 'estimate' so the UI reads it as a guess and the observed
-- overlay still promotes it to a measured value once a route clears the sample
-- floor (the estimate->measured flip). This only ADDS a value to the allowed set;
-- existing 'openrouter'/'observed' rows are unaffected.

alter table public.model_providers
  drop constraint if exists model_providers_stats_source_check;
alter table public.model_providers
  add constraint model_providers_stats_source_check
  check (stats_source in ('openrouter', 'observed', 'estimate'));
