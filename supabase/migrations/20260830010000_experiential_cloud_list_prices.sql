-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Production is migration-only: editing seed-gateway-catalog.sql does not
-- rewrite existing public experiential_cloud deployments. This UPDATE applies
-- the 20%-below-OpenRouter list (retrieved 2026-08-22) to those two house
-- rows. It never INSERTs, so a database that lacks the rows stays empty.
-- Scope is the seed-owned canonical pair: public model, public deployment,
-- canonical provider_model_id, and base_url IS NULL. Org-scoped rows
-- (owning_org_id set) and public custom origins (same provider_model_id,
-- non-null base_url) stay untouched. Re-running writes the same values
-- and is a no-op. Fresh and reseeded environments get the same prices from
-- the catalog seed.

update public.model_providers deployments
set
  input_micro_usd_per_million = prices.input_micro,
  cached_input_micro_usd_per_million = prices.cached_micro,
  output_micro_usd_per_million = prices.output_micro,
  pricing_source = prices.pricing_source,
  pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
from (
  values
    (
      'deepseek-v4-flash',
      'deepseek-v4-flash',
      42448::bigint,
      8489::bigint,
      84896::bigint,
      'openrouter:deepseek/deepseek-v4-flash@2026-08-22*0.8'
    ),
    (
      'qwen3.8-27b',
      'qwen3.8-27b',
      320000::bigint,
      40000::bigint,
      2400000::bigint,
      'openrouter:qwen/qwen3.8-27b@2026-08-22*0.8'
    )
) as prices(
  slug, provider_model_id, input_micro, cached_micro, output_micro, pricing_source
)
join public.models models
  on models.slug = prices.slug
 and models.owning_org_id is null
where deployments.model_id = models.id
  and deployments.provider = 'experiential_cloud'
  and deployments.provider_model_id = prices.provider_model_id
  and deployments.owning_org_id is null
  and deployments.base_url is null;
