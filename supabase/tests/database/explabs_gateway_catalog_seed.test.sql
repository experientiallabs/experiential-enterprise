-- Seeded gateway catalog state (core-P2, extended in gw-r2): the house org,
-- the pinned preferred models in the decided rank order (core-P2's 1..14 plus
-- the gw-r2 additions qwen3.8-27b and the Claude family), their launch
-- deployments and default waterfalls. Runs against a seeded database
-- (run_supabase_integration_tests.sh seeds before `supabase test db`; preview
-- branches are seeded by seed_supabase_branch.sh). Secret-bearing sections of
-- the seed are environment-gated, so this file asserts their invariants
-- rather than their presence.

begin;

create extension if not exists pgtap with schema extensions;

select plan(29);

-- The house org that owns the platform-funded lane.

select is(
  (
    select slug from public.organizations
    where id = '00000000-0000-0000-0000-000000000004'
  ),
  'experiential-labs-house',
  'the house org exists on its stable id'
);

-- House connections only ever carry the seven gateway launch providers
-- (fireworks joined in gw-r2 for the house-lane routing map, section 9).

select is(
  (
    select count(*)::int from public.provider_connections
    where org_id = '00000000-0000-0000-0000-000000000004'
      and provider not in (
        'openai', 'anthropic', 'azure_openai', 'openrouter', 'bedrock', 'gemini', 'fireworks'
      )
  ),
  0,
  'every house connection is one of the seven launch providers'
);

-- The recommended (preferred) list, ranks 0..13 in the product owner's r2 refined order:
-- Ox Alpha is pinned at rank 0 as the top featured model (the product owner: pin ox alpha at
-- the top of the models page), then Fable and Opus 5 lead the rest as the
-- most-used models, followed by the rest of the Claude line and one strong model
-- per frontier family (GPT-5.6 Sol + Luna, Gemini 3.7 Flash, Kimi K2.6, GLM
-- 5.3, DeepSeek V4 Flash, Qwen3.8 27B) — the r3 trim (the product owner 2026-08-22)
-- dropped Haiku 4.5, Grok 4.6, DeepSeek V4 Pro, and Qwen3.5 9B into their
-- folded sections. Every other real model stays in the catalog, folded and
-- unstarred.

select is(
  (
    select array_agg(slug order by preferred_rank)
    from public.models
    where owning_org_id is null and preferred_rank is not null
  ),
  array[
    'ox-alpha',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'gemini-3.7-flash',
    'kimi-k2.6',
    'glm-5.3',
    'deepseek-v4-flash',
    'qwen3.8-27b'
  ],
  'the recommended models are pinned in the decided order (Ox Alpha leads at rank 0)'
);

select is(
  (
    select array_agg(preferred_rank order by preferred_rank)
    from public.models
    where owning_org_id is null and preferred_rank is not null
  ),
  array[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  'preferred ranks are exactly 0..10 (ox-alpha pinned above the band at 0)'
);

-- Every preferred model resolves through a default chain: don't list a model
-- you can't call. qwen3.5-4b, the one prior gap (no verified hosted wire id),
-- was removed from the public catalog rather than left listed-but-not-callable.

select is(
  (
    select coalesce(array_agg(models.slug order by models.preferred_rank), '{}')
    from public.models models
    where models.owning_org_id is null
      and models.preferred_rank is not null
      and not exists (
        select 1
        from public.model_waterfalls rungs
        join public.model_providers deployments
          on deployments.id = rungs.model_provider_id
        where rungs.model_id = models.id
          and rungs.org_id is null
          and rungs.position = 0
          and deployments.status = 'active'
      )
  ),
  '{}'::text[],
  'every preferred model resolves at rung 0 (no listed-but-not-callable rows)'
);

-- Preferred deployments never ship unknown launch prices (null would render
-- as free; the schema forbids zero-filling instead).

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where models.owning_org_id is null
      and models.preferred_rank is not null
      and (
        deployments.input_micro_usd_per_million is null
        or deployments.output_micro_usd_per_million is null
      )
  ),
  0,
  'every preferred deployment carries input and output prices'
);

-- Servability: every preferred model resolves at rung 0 to a deployment the
-- gateway can actually run: platform-funded (host_managed), streaming-capable,
-- with a computable worst-case cost (base rates present, and no reported token
-- kind (cached, reasoning) declared without its rate).

select is(
  (
    select count(*)::int
    from public.model_waterfalls rungs
    join public.models models
      on models.id = rungs.model_id
      and models.owning_org_id is null
      and models.preferred_rank is not null
    join public.model_providers deployments
      on deployments.id = rungs.model_provider_id
    where rungs.org_id is null
      and rungs.position = 0
      and deployments.status = 'active'
      and deployments.billing_source = 'host_managed'
      and (deployments.capabilities ->> 'supports_streaming')::boolean
      and deployments.input_micro_usd_per_million is not null
      and deployments.output_micro_usd_per_million is not null
      and not (
        coalesce((deployments.capabilities ->> 'reports_cached_input_tokens')::boolean, false)
        and deployments.cached_input_micro_usd_per_million is null
      )
      and not (
        coalesce((deployments.capabilities ->> 'reports_reasoning_tokens')::boolean, false)
        and deployments.reasoning_micro_usd_per_million is null
      )
  ),
  11,
  'all 11 deployment-backed recommended models are servable on the platform lane with computable worst-case cost'
);

-- the product owner r2: inkling was added via OpenRouter ("go through openrouter for now").
-- A listed public model must be callable, so it must resolve at rung 0 to an
-- active host_managed deployment — not listed-but-dead. (muse-spark was also
-- requested but meta/muse-spark-1.2 is 403 on our OpenRouter lane with no
-- callable route anywhere, so it is deliberately NOT listed.)
select is(
  (
    select coalesce(array_agg(models.slug order by models.slug), '{}')
    from public.models models
    where models.owning_org_id is null
      and models.slug in ('inkling')
      and exists (
        select 1
        from public.model_waterfalls rungs
        join public.model_providers deployments
          on deployments.id = rungs.model_provider_id
        where rungs.model_id = models.id
          and rungs.org_id is null
          and rungs.position = 0
          and deployments.status = 'active'
          and deployments.billing_source = 'host_managed'
      )
  ),
  array['inkling'],
  'product-owner-requested inkling is listed and callable at rung 0'
);

-- Identity reconciliation (r3): Inkling Small was showing under Fireworks only
-- because the curated catalog carried `inkling` but not `inkling-small`. The
-- seed now carries the OpenRouter route on the canonical `inkling-small` slug,
-- so the model is listed and callable at rung 0 through the host lane, and the
-- Fireworks discovery lane merges onto the same catalog model.
select is(
  (
    select coalesce(array_agg(models.slug order by models.slug), '{}')
    from public.models models
    where models.owning_org_id is null
      and models.slug in ('inkling-small')
      and exists (
        select 1
        from public.model_waterfalls rungs
        join public.model_providers deployments
          on deployments.id = rungs.model_provider_id
        where rungs.model_id = models.id
          and rungs.org_id is null
          and rungs.position = 0
          and deployments.status = 'active'
          and deployments.billing_source = 'host_managed'
      )
  ),
  array['inkling-small'],
  'Inkling Small is reconciled onto one catalog model, listed and callable at rung 0'
);

-- Promotional set (v2, scoped): the three free tiers plus the GPT-on-EC
-- discount are seeded active by the authoritative promotions seed (admin-safe:
-- label-keyed, never clobbers operator edits). The catalog only READS the
-- display projection for its Promotional section. Distinct from
-- preferred_rank — a promo model is also listed in its family section.
select is(
  (
    select coalesce(array_agg(promos.label order by promos.display_order), '{}')
    from public.model_promotions promos
    where promos.active
  ),
  array['qwen3.8-27b', 'deepseek-v4-flash', 'gpt-5.6-luna',
        'GPT on Experiential Cloud - 50% off'],
  'the launch promotions are seeded active in display order'
);

select ok(
  exists (
    select 1 from public.model_promotions promos
    where promos.label = 'GPT on Experiential Cloud - 50% off'
      and promos.percent_off = 50
      and promos.discount_cap_micro_usd = 50000000000
      and promos.providers = array['experiential_cloud']
      and promos.audience_labels = array['yc']
      and promos.family_keys = '{}'
      and promos.per_org_cap_micro_usd = 0
      and promos.cap_scope = 'lifetime'
  ),
  'the GPT-on-EC promotion is 50% off via experiential_cloud, YC accounts only, $50k per-org ceiling, no free tier'
);

select is(
  (
    select coalesce(array_agg(members.slug order by members.slug), '{}')
    from public.model_promotion_models members
    join public.model_promotions promos on promos.id = members.promotion_id
    where promos.label = 'GPT on Experiential Cloud - 50% off'
  ),
  array['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  'the GPT-on-EC promotion covers exactly the 5.6 luna/sol/terra trio'
);

-- Experiential Cloud rungs lead every default chain that carries them (owner
-- decision 2026-08-24). EC-first means no non-EC rung sits below any EC rung.
select is(
  (
    select count(*)::int
    from public.model_waterfalls w
    join public.model_providers mp on mp.id = w.model_provider_id
    where w.org_id is null
      and mp.provider <> 'experiential_cloud'
      and w.position < (
        select max(w2.position)
        from public.model_waterfalls w2
        join public.model_providers mp2 on mp2.id = w2.model_provider_id
        where w2.model_id = w.model_id
          and w2.org_id is null
          and mp2.provider = 'experiential_cloud'
      )
  ),
  0,
  'experiential_cloud rungs lead every default chain that carries them'
);

-- One wire id, one catalog model. `model_providers_identity_key` is unique on
-- (model_id, provider, provider_model_id, owning_org_id, base_url), so a second
-- model row for the SAME provider wire id inserts without any conflict firing —
-- the constraint cannot catch it, and the catalog then lists the same model
-- twice (the 2026-08-24 daily sync seeded `l3.3-euryale-70b` beside
-- `llama-3.3-euryale-70b` on `sao10k/l3.3-euryale-70b` that way). A model may
-- carry several wire ids on one provider (a base plus its dated snapshot), but
-- one wire id never carries several models.

select is(
  (
    select coalesce(
      array_agg(dup.provider || ':' || dup.provider_model_id order by dup.provider_model_id),
      '{}'
    )
    from (
      select deployments.provider, deployments.provider_model_id
      from public.model_providers deployments
      join public.models models
        on models.id = deployments.model_id and models.owning_org_id is null
      where deployments.owning_org_id is null
      group by deployments.provider, deployments.provider_model_id, deployments.base_url
      having count(distinct deployments.model_id) > 1
    ) dup
  ),
  '{}'::text[],
  'no provider wire id is bound to two public catalog models'
);

-- The pricing coupling holds catalog-wide, not just on preferred rows: no
-- deployment anywhere claims a reported token kind without its rate.

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    where (
      coalesce((deployments.capabilities ->> 'reports_cached_input_tokens')::boolean, false)
      and deployments.cached_input_micro_usd_per_million is null
    ) or (
      coalesce((deployments.capabilities ->> 'reports_reasoning_tokens')::boolean, false)
      and deployments.reasoning_micro_usd_per_million is null
    )
  ),
  0,
  'no deployment declares a reported token kind without seeding its rate'
);

-- Owned-model serving invariants (grafted from core-p2/int-p3 main lineage so
-- the org-owned local-model coverage survives the gw-r2 catalog rewrite). These
-- pass vacuously while no owned models are seeded and lock the serving contract
-- for legitimately added local models (punchlist: "add a local model").

select is(
  (
    select count(*)::int
    from public.models models
    where models.category = 'owned'
      and not exists (
        select 1 from public.model_providers deployments
        where deployments.model_id = models.id
          and deployments.provider = 'local'
          and deployments.billing_source = 'host_managed'
          and deployments.base_url is not null
          and (deployments.capabilities ->> 'supports_streaming')::boolean
      )
  ),
  0,
  'every owned model has a streaming-capable local host_managed deployment with a base_url'
);

select is(
  (
    select count(*)::int
    from public.models models
    where models.category = 'owned'
      and not exists (
        select 1
        from public.model_waterfalls rungs
        join public.model_providers deployments
          on deployments.id = rungs.model_provider_id
        where rungs.model_id = models.id
          and rungs.org_id is null
          and rungs.position = 0
          and deployments.provider = 'local'
      )
  ),
  0,
  'every owned model resolves through a rung-0 local deployment'
);

select is(
  (
    select count(*)::int from public.models
    where category = 'owned'
      and (owning_org_id is null or preferred_rank is not null)
  ),
  0,
  'owned models are org-scoped and never pinned into the public preferred list'
);

-- The legacy-endpoint fold is gone: no seed promotes a Project-era serving
-- endpoint into the catalog as an org-owned `category = 'owned'` model. The
-- fold was removed here in gw-r2 and the drop_legacy_folded_owned_models
-- migration clears any left in a long-lived database; this guards the merge
-- against a stale seed reintroducing the artifact.

select is(
  (select count(*)::int from public.models where category = 'owned'),
  0,
  'no legacy-folded owned models remain in the catalog'
);

select is(
  (
    select array_agg(models.slug order by models.slug)
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and models.owning_org_id is null
  ),
  array['deepseek-v4-flash', 'qwen3.8-27b'],
  'Experiential Cloud seeds the two native vLLM public aliases'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and models.slug = 'deepseek-v4-flash'
      and deployments.input_micro_usd_per_million = 42448
      and deployments.cached_input_micro_usd_per_million = 8489
      and deployments.output_micro_usd_per_million = 84896
      and deployments.billing_source = 'host_managed'
      and deployments.pricing_source = 'openrouter:deepseek/deepseek-v4-flash@2026-08-22*0.8'
      and deployments.pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
  ),
  1,
  'deepseek-v4-flash Experiential Cloud list is 20% below the 2026-08-22 OpenRouter market, flooring cached input'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
      and models.slug = 'qwen3.8-27b'
      and deployments.input_micro_usd_per_million = 320000
      and deployments.cached_input_micro_usd_per_million = 40000
      and deployments.output_micro_usd_per_million = 2400000
      and deployments.billing_source = 'host_managed'
      and deployments.pricing_source = 'openrouter:qwen/qwen3.8-27b@2026-08-22*0.8'
      and deployments.pricing_effective_at = '2026-08-22T00:00:00Z'::timestamptz
  ),
  1,
  'qwen3.8-27b Experiential Cloud list is 20% below the 2026-08-22 OpenRouter market'
);

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.model_waterfalls rungs
      on rungs.model_provider_id = deployments.id
      and rungs.model_id = deployments.model_id
      and rungs.org_id is null
    where deployments.provider = 'experiential_cloud'
      and deployments.owning_org_id is null
  ),
  2,
  'each Experiential Cloud deployment appears once on the public default chain'
);

-- A model may have multiple native origins represented by distinct provider
-- rows. Re-running the actual seed must append every missing row at a distinct
-- position, then remain idempotent once all rows are present.
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
  'deepseek-v4-flash-secondary',
  'https://secondary.invalid/v1',
  'host_managed',
  42448,
  8489,
  84896,
  'test',
  '2026-08-22T00:00:00+00:00'::timestamptz,
  '{"supports_streaming": true}'::jsonb
from public.models models
where models.slug = 'deepseek-v4-flash'
  and models.owning_org_id is null;

\ir ../../seed-gateway-catalog.sql
\ir ../../seed-gateway-catalog.sql

select is(
  (
    select count(*)::int
    from public.model_providers deployments
    join public.models models on models.id = deployments.model_id
    join public.model_waterfalls rungs
      on rungs.model_id = deployments.model_id
      and rungs.org_id is null
      and rungs.model_provider_id = deployments.id
    where models.slug = 'deepseek-v4-flash'
      and models.owning_org_id is null
      and deployments.provider = 'experiential_cloud'
  ),
  2,
  're-seeding appends every same-model Experiential Cloud deployment exactly once'
);

-- OpenRouter backfill (section 10): every model with an OpenRouter route now
-- carries a release date pulled from the live OR listing, so the previously
-- date-less preferred rows (kimi-k2.6, glm-5.3, the gpt-5.6 line, ...) are filled.
select is(
  (
    select count(*)::int
    from public.models m
    where m.owning_org_id is null
      and m.release_date is null
      and exists (
        select 1 from public.model_providers mp
        where mp.model_id = m.id and mp.provider = 'openrouter' and mp.owning_org_id is null
      )
  ),
  0,
  'every OpenRouter-routed model has a release date after the backfill'
);

-- Honesty pass (10c): no native cross-provider row is left mislabeled as an
-- OpenRouter-sourced price; a borrowed price reads as an estimate.
select is(
  (
    select count(*)::int
    from public.model_providers mp
    where mp.owning_org_id is null
      and mp.provider not in ('openrouter', 'experiential_cloud', 'local', 'modal')
      and mp.pricing_source = 'openrouter'
  ),
  0,
  'no native provider row is left labeled pricing_source=openrouter (borrowed prices are estimates)'
);

-- Defaults-only recommended set (admin-recommended-models): the seed writes
-- preferred_rank ONLY when no public model is ranked (section 8's guard; the
-- model upserts never touch ranks), so a re-seed must never clobber an
-- operator's curation. Simulate one through the admin definer function, run
-- the seed again, and the curation survives.
select is(
  (
    select array_agg(applied.slug order by applied.preferred_rank)
    from public.recommended_models_apply(array['qwen3.6-27b', 'kimi-k2.6']) applied
  ),
  array['qwen3.6-27b', 'kimi-k2.6'],
  'the admin apply replaces the recommended set in list order'
);

\ir ../../seed-gateway-catalog.sql

select is(
  (
    select array_agg(models.slug order by models.preferred_rank)
    from public.models models
    where models.owning_org_id is null and models.preferred_rank is not null
  ),
  array['qwen3.6-27b', 'kimi-k2.6'],
  're-seeding an admin-managed catalog leaves the recommended set alone'
);

select is(
  (
    select array_agg(models.preferred_rank order by models.preferred_rank)
    from public.models models
    where models.owning_org_id is null and models.preferred_rank is not null
  ),
  array[0, 1],
  're-seeding preserves the admin-assigned ranks'
);

select * from finish();

rollback;
