-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Per-LANE price estimates so no provider lane renders "- /M in · - /M out"
-- (the product owner r4; screenshot offenders: Fireworks kimi-k2p6, Azure FW-Kimi-K2.6 —
-- the earlier fills covered model metadata and stats, not each lane's own
-- token prices).
--
-- Two-stage fill over every unpriced public lane, marked
-- pricing_source='estimate' so the UI renders the ≈ marker and the
-- estimate→measured design still governs:
--   1. SIBLING reference: the model's best priced lane (OpenRouter first, then
--      any authoritative source).
--   2. CATALOG MEDIAN fallback for models with no priced lane at all (the
--      discovery long tail): the median input/output price across every
--      authoritatively priced lane — a deliberately conservative, clearly
--      marked guess.
--
-- SERVING IS UNTOUCHED, and that is load-bearing: statuses are not modified
-- here, and the catalog sync's activation gate now refuses to activate a
-- host-managed lane whose price source is 'estimate' (an estimated price is
-- display information, never a billing rate — the "never invent a price"
-- launch policy). A BYOK lane's price is informational either way: the
-- caller's own provider bills them.
--
-- Idempotent: only null-priced lanes are touched; re-runs find none.

-- 1. Sibling reference.
update public.model_providers mp
set input_micro_usd_per_million = src.input_micro,
    cached_input_micro_usd_per_million = src.cached_micro,
    output_micro_usd_per_million = src.output_micro,
    pricing_source = 'estimate',
    pricing_effective_at = now()
from (
  select distinct on (sibling.model_id)
    sibling.model_id,
    sibling.input_micro_usd_per_million as input_micro,
    sibling.cached_input_micro_usd_per_million as cached_micro,
    sibling.output_micro_usd_per_million as output_micro
  from public.model_providers sibling
  where sibling.owning_org_id is null
    and sibling.input_micro_usd_per_million is not null
    and sibling.output_micro_usd_per_million is not null
    and (sibling.pricing_source is null or sibling.pricing_source <> 'estimate')
  order by sibling.model_id,
    (sibling.provider = 'openrouter') desc,
    (sibling.pricing_source in ('openrouter', 'provider-docs', 'aws-price-list')) desc,
    sibling.created_at,
    sibling.id
) src
where mp.model_id = src.model_id
  and mp.owning_org_id is null
  and (mp.input_micro_usd_per_million is null or mp.output_micro_usd_per_million is null);

-- 2. Catalog-median fallback for models with no priced lane to reference.
update public.model_providers mp
set input_micro_usd_per_million = medians.input_micro,
    output_micro_usd_per_million = medians.output_micro,
    pricing_source = 'estimate',
    pricing_effective_at = now()
from (
  select
    (percentile_cont(0.5) within group (
       order by priced.input_micro_usd_per_million))::bigint as input_micro,
    (percentile_cont(0.5) within group (
       order by priced.output_micro_usd_per_million))::bigint as output_micro
  from public.model_providers priced
  where priced.owning_org_id is null
    and priced.input_micro_usd_per_million is not null
    and priced.output_micro_usd_per_million is not null
    and (priced.pricing_source is null or priced.pricing_source <> 'estimate')
) medians
where mp.owning_org_id is null
  and (mp.input_micro_usd_per_million is null or mp.output_micro_usd_per_million is null)
  and medians.input_micro is not null
  and medians.output_micro is not null;
