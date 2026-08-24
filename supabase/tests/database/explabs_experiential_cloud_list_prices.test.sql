-- Production is migration-only. This file rewinds the seeded public
-- Experiential Cloud list to the retired 90% prices, then runs the shipped
-- UPDATE so the contract is the migration file itself: it rewrites the two
-- seed-owned house rows (public, canonical provider_model_id, base_url IS
-- NULL), creates nothing, and leaves org-scoped rows and public custom
-- origins (same provider_model_id, non-null base_url) untouched. A second
-- \ir proves idempotency. Final prices after seed are also asserted in
-- explabs_gateway_catalog_seed.test.sql.

begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

insert into public.organizations (id, slug, name)
values (
  'c1000000-0000-0000-0000-000000000001',
  'ec-list-price-org',
  'Experiential Cloud List Price Org'
);

-- Rewind only the seed-owned house rows (null base_url) so the migration
-- has something to update. A public custom origin with the same
-- provider_model_id must not be rewritten here either.
update public.model_providers deployments
set
  input_micro_usd_per_million = rewind.input_micro,
  cached_input_micro_usd_per_million = rewind.cached_micro,
  output_micro_usd_per_million = rewind.output_micro,
  pricing_source = rewind.pricing_source,
  pricing_effective_at = '2026-01-01T00:00:00Z'::timestamptz
from (
  values
    (
      'deepseek-v4-flash',
      72000::bigint,
      14400::bigint,
      162000::bigint,
      'openrouter:deepseek/deepseek-v4-flash-0731@2026-08-22*0.9'
    ),
    (
      'qwen3.8-27b',
      405000::bigint,
      45000::bigint,
      2880000::bigint,
      'openrouter:qwen/qwen3.8-27b@2026-08-22*0.9'
    )
) as rewind(slug, input_micro, cached_micro, output_micro, pricing_source)
join public.models models
  on models.slug = rewind.slug
 and models.owning_org_id is null
where deployments.model_id = models.id
  and deployments.provider = 'experiential_cloud'
  and deployments.provider_model_id = rewind.slug
  and deployments.owning_org_id is null
  and deployments.base_url is null;

-- Org-scoped clone of the DeepSeek public alias: same provider_model_id,
-- different owner. Must keep these prices.
insert into public.model_providers (
  model_id,
  provider,
  provider_model_id,
  owning_org_id,
  billing_source,
  input_micro_usd_per_million,
  cached_input_micro_usd_per_million,
  output_micro_usd_per_million,
  pricing_source,
  pricing_effective_at,
  capabilities
)
select
  models.id,
  'experiential_cloud',
  'deepseek-v4-flash',
  'c1000000-0000-0000-0000-000000000001',
  'host_managed',
  111::bigint,
  222::bigint,
  333::bigint,
  'org-scoped-must-not-change',
  '2026-01-01T00:00:00Z'::timestamptz,
  '{"supports_streaming": true}'::jsonb
from public.models models
where models.slug = 'deepseek-v4-flash'
  and models.owning_org_id is null;

-- Public custom origin on the SAME canonical provider_model_id, distinguished
-- only by a non-null base_url. Prices and provenance must survive both applies.
insert into public.model_providers (
  model_id,
  provider,
  provider_model_id,
  base_url,
  billing_source,
  input_micro_usd_per_million,
  cached_input_micro_usd_per_million,
  output_micro_usd_per_million,
  pricing_source,
  pricing_effective_at,
  capabilities
)
select
  models.id,
  'experiential_cloud',
  'deepseek-v4-flash',
  'https://custom.invalid/v1',
  'host_managed',
  999::bigint,
  888::bigint,
  777::bigint,
  'custom-public-must-not-change',
  '2026-01-01T00:00:00Z'::timestamptz,
  '{"supports_streaming": true}'::jsonb
from public.models models
where models.slug = 'deepseek-v4-flash'
  and models.owning_org_id is null;

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.base_url is null
      and models.owning_org_id is null
      and deployments.provider_model_id = models.slug
      and (
        (
          models.slug = 'deepseek-v4-flash'
          and deployments.input_micro_usd_per_million = 72000
          and deployments.pricing_source
            = 'openrouter:deepseek/deepseek-v4-flash-0731@2026-08-22*0.9'
        )
        or (
          models.slug = 'qwen3.8-27b'
          and deployments.input_micro_usd_per_million = 405000
          and deployments.pricing_source
            = 'openrouter:qwen/qwen3.8-27b@2026-08-22*0.9'
        )
      )
  ),
  2,
  'fixture rewound both seed-owned public Experiential Cloud lists to the retired 90% prices'
);

\ir ../../migrations/20260830010000_experiential_cloud_list_prices.sql

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.base_url is null
      and models.owning_org_id is null
      and models.slug = 'deepseek-v4-flash'
      and deployments.provider_model_id = 'deepseek-v4-flash'
      and deployments.input_micro_usd_per_million = 42448
      and deployments.cached_input_micro_usd_per_million = 8489
      and deployments.output_micro_usd_per_million = 84896
      and deployments.pricing_source = 'openrouter:deepseek/deepseek-v4-flash@2026-08-22*0.8'
      and deployments.pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
  ),
  1,
  'migration updates the seed-owned public deepseek-v4-flash Experiential Cloud list'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.base_url is null
      and models.owning_org_id is null
      and models.slug = 'qwen3.8-27b'
      and deployments.provider_model_id = 'qwen3.8-27b'
      and deployments.input_micro_usd_per_million = 320000
      and deployments.cached_input_micro_usd_per_million = 40000
      and deployments.output_micro_usd_per_million = 2400000
      and deployments.pricing_source = 'openrouter:qwen/qwen3.8-27b@2026-08-22*0.8'
      and deployments.pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
  ),
  1,
  'migration updates the seed-owned public qwen3.8-27b Experiential Cloud list'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id = 'c1000000-0000-0000-0000-000000000001'
      and deployments.provider_model_id = 'deepseek-v4-flash'
      and deployments.input_micro_usd_per_million = 111
      and deployments.cached_input_micro_usd_per_million = 222
      and deployments.output_micro_usd_per_million = 333
      and deployments.pricing_source = 'org-scoped-must-not-change'
      and deployments.pricing_effective_at = '2026-01-01T00:00:00Z'::timestamptz
  ),
  1,
  'migration does not touch an org-scoped Experiential Cloud deployment'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.provider_model_id = 'deepseek-v4-flash'
      and deployments.base_url = 'https://custom.invalid/v1'
      and deployments.input_micro_usd_per_million = 999
      and deployments.cached_input_micro_usd_per_million = 888
      and deployments.output_micro_usd_per_million = 777
      and deployments.pricing_source = 'custom-public-must-not-change'
      and deployments.pricing_effective_at = '2026-01-01T00:00:00Z'::timestamptz
  ),
  1,
  'migration does not rewrite a public custom origin that shares the canonical provider_model_id'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where deployments.provider = 'experiential_cloud'
  ),
  4,
  'migration does not create Experiential Cloud rows'
);

\ir ../../migrations/20260830010000_experiential_cloud_list_prices.sql

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.base_url is null
      and models.slug = 'deepseek-v4-flash'
      and deployments.provider_model_id = 'deepseek-v4-flash'
      and deployments.input_micro_usd_per_million = 42448
      and deployments.cached_input_micro_usd_per_million = 8489
      and deployments.output_micro_usd_per_million = 84896
      and deployments.pricing_source = 'openrouter:deepseek/deepseek-v4-flash@2026-08-22*0.8'
      and deployments.pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
  ),
  1,
  're-running the migration keeps the seed-owned public DeepSeek list'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.base_url is null
      and models.slug = 'qwen3.8-27b'
      and deployments.provider_model_id = 'qwen3.8-27b'
      and deployments.input_micro_usd_per_million = 320000
      and deployments.cached_input_micro_usd_per_million = 40000
      and deployments.output_micro_usd_per_million = 2400000
      and deployments.pricing_source = 'openrouter:qwen/qwen3.8-27b@2026-08-22*0.8'
      and deployments.pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
  ),
  1,
  're-running the migration keeps the seed-owned public Qwen list'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where deployments.provider = 'experiential_cloud'
  ),
  4,
  're-running the migration still creates no Experiential Cloud rows'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id = 'c1000000-0000-0000-0000-000000000001'
      and deployments.provider_model_id = 'deepseek-v4-flash'
      and deployments.input_micro_usd_per_million = 111
      and deployments.cached_input_micro_usd_per_million = 222
      and deployments.output_micro_usd_per_million = 333
      and deployments.pricing_source = 'org-scoped-must-not-change'
      and deployments.pricing_effective_at = '2026-01-01T00:00:00Z'::timestamptz
  ),
  1,
  're-running the migration still leaves the org-scoped deployment alone'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and deployments.provider_model_id = 'deepseek-v4-flash'
      and deployments.base_url = 'https://custom.invalid/v1'
      and deployments.input_micro_usd_per_million = 999
      and deployments.cached_input_micro_usd_per_million = 888
      and deployments.output_micro_usd_per_million = 777
      and deployments.pricing_source = 'custom-public-must-not-change'
      and deployments.pricing_effective_at = '2026-01-01T00:00:00Z'::timestamptz
  ),
  1,
  're-running the migration still leaves the same-id public custom origin prices and provenance alone'
);

select * from finish();

rollback;
