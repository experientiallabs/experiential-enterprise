-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Cross-provider catalog dedup (r3): collapse the ~187 legacy provider-namespaced
-- duplicate `models` rows onto their canonical model.
--
-- The multi-provider discovery sync (Azure/Bedrock/Fireworks/OpenRouter) minted a
-- SEPARATE public `models` row per provider spelling of the SAME base model —
-- e.g. GLM 5.2 landed as OpenRouter `z-ai/glm-5.2` (canonical `glm-5.2`), Azure
-- `FW-GLM-5.2`, Fireworks `glm-5p2`/`glm-5p2-fp8`, Bedrock `zai.glm-5` — under
-- distinct provider-namespaced slugs (`azure_openai-*` / `bedrock-*` /
-- `fireworks-*`). This migration repoints every such duplicate's provider rows
-- onto the ONE canonical model and deletes the emptied duplicate rows, so the
-- catalog shows one model with all its provider lanes. The forward-fix
-- (explabs/gateway/model_aliases) makes future syncs merge these spellings so the
-- dupes never re-appear.
--
-- Conservatism: only provider-namespaced duplicate rows are collapsed. A row on a
-- DIFFERENT clean/curated model is never moved (e.g. deepseek-v4-flash's
-- deliberate Fireworks 0731 fallback stays put), and dated snapshots / *-fast /
-- *-pro tiers / :batch modes / different sizes stay separate models.
--
-- Idempotent and environment-independent: it keys on the legacy namespaced slug
-- (stable text), so it cleans the long-lived production catalog and is a no-op on
-- a fresh DB (which has no such rows yet). Re-running finds nothing to collapse.

create temporary table catalog_dedup_map (
  dup_slug text primary key,
  canonical_slug text not null
);
insert into catalog_dedup_map (dup_slug, canonical_slug) values
  ('azure_openai-claude-fable-5', 'claude-fable-5'),
  ('azure_openai-claude-haiku-4-5', 'claude-haiku-4.5'),
  ('azure_openai-claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'),
  ('azure_openai-claude-opus-4-5-20251101', 'claude-opus-4-5-20251101'),
  ('azure_openai-claude-opus-4-7', 'claude-opus-4-7'),
  ('azure_openai-claude-opus-4-8', 'claude-opus-4.8'),
  ('azure_openai-claude-opus-5', 'claude-opus-5'),
  ('azure_openai-claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'),
  ('azure_openai-claude-sonnet-4-6', 'claude-sonnet-4-6'),
  ('azure_openai-claude-sonnet-5', 'claude-sonnet-5'),
  ('azure_openai-deepseek-r1', 'deepseek-r1'),
  ('azure_openai-deepseek-r1-0528', 'deepseek-r1-0528'),
  ('azure_openai-deepseek-v3', 'deepseek-v3'),
  ('azure_openai-deepseek-v3-0324', 'deepseek-v3-0324'),
  ('azure_openai-deepseek-v3.1', 'deepseek-v3.1'),
  ('azure_openai-deepseek-v3.2', 'deepseek-v3.2'),
  ('azure_openai-deepseek-v4-flash', 'deepseek-v4-flash'),
  ('azure_openai-deepseek-v4-flash-0731', 'deepseek-v4-flash-0731'),
  ('azure_openai-deepseek-v4-pro', 'deepseek-v4-pro'),
  ('azure_openai-fw-deepseek-v3.1', 'deepseek-v3.1'),
  ('azure_openai-fw-deepseek-v3.2', 'deepseek-v3.2'),
  ('azure_openai-fw-deepseek-v4-flash', 'deepseek-v4-flash'),
  ('azure_openai-fw-deepseek-v4-flash-0731', 'deepseek-v4-flash-0731'),
  ('azure_openai-fw-deepseek-v4-pro', 'deepseek-v4-pro'),
  ('azure_openai-fw-gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it'),
  ('azure_openai-fw-gemma-4-31b-it', 'gemma-4-31b-it'),
  ('azure_openai-fw-glm-4.7', 'glm-4.7'),
  ('azure_openai-fw-glm-5', 'glm-5'),
  ('azure_openai-fw-glm-5.1', 'glm-5.1'),
  ('azure_openai-fw-glm-5.2', 'glm-5.2'),
  ('azure_openai-fw-glm-5.2-fast', 'glm-5.2-fast'),
  ('azure_openai-fw-gpt-oss-120b', 'gpt-oss-120b'),
  ('azure_openai-fw-gpt-oss-20b', 'gpt-oss-20b'),
  ('azure_openai-fw-inkling', 'inkling'),
  ('azure_openai-fw-kimi-k2-instruct-0905', 'kimi-k2-instruct-0905'),
  ('azure_openai-fw-kimi-k2-thinking', 'kimi-k2-thinking'),
  ('azure_openai-fw-kimi-k2.5', 'kimi-k2.5'),
  ('azure_openai-fw-kimi-k2.6', 'kimi-k2.6'),
  ('azure_openai-fw-kimi-k2.7-code', 'kimi-k2.7-code'),
  ('azure_openai-fw-kimi-k3', 'kimi-k3'),
  ('azure_openai-fw-llama-v3.1-8b-instruct', 'llama-v3.1-8b-instruct'),
  ('azure_openai-fw-minimax-m2.5', 'minimax-m2.5'),
  ('azure_openai-fw-minimax-m3', 'minimax-m3'),
  ('azure_openai-fw-ministral-3-3b-instruct-2512', 'ministral-3-3b-instruct-2512'),
  ('azure_openai-fw-nemotron-3-super-120b-a12b-bf16', 'nemotron-3-super-120b-a12b'),
  ('azure_openai-fw-nemotron-3-ultra-nvfp4', 'nemotron-3-ultra-550b-a55b'),
  ('azure_openai-fw-nemotron-lightning-3.5-30b-a3b', 'nemotron-3.5-lightning'),
  ('azure_openai-fw-qwen3-14b', 'qwen3-14b'),
  ('azure_openai-fw-qwen3-32b', 'qwen3-32b'),
  ('azure_openai-fw-qwen3.5-122b-a10b', 'qwen3.5-122b-a10b'),
  ('azure_openai-fw-qwen3.5-27b', 'qwen3.5-27b'),
  ('azure_openai-fw-qwen3.5-35b-a3b', 'qwen3.5-35b-a3b'),
  ('azure_openai-fw-qwen3.5-397b-a17b', 'qwen3.5-397b-a17b'),
  ('azure_openai-fw-qwen3.5-4b', 'qwen3.5-4b'),
  ('azure_openai-fw-qwen3.5-9b', 'qwen3.5-9b'),
  ('azure_openai-fw-qwen3.6-27b', 'qwen3.6-27b'),
  ('azure_openai-fw-qwen3.6-35b-a3b', 'qwen3.6-35b-a3b'),
  ('azure_openai-gpt-5.5', 'gpt-5.5'),
  ('azure_openai-gpt-5.6-luna', 'gpt-5.6-luna'),
  ('azure_openai-gpt-5.6-sol', 'gpt-5.6-sol'),
  ('azure_openai-gpt-5.6-terra', 'gpt-5.6-terra'),
  ('azure_openai-gpt-chat-latest', 'gpt-chat-latest'),
  ('azure_openai-gpt-oss-120b', 'gpt-oss-120b'),
  ('azure_openai-gpt-oss-20b', 'gpt-oss-20b'),
  ('azure_openai-grok-4-20-reasoning', 'grok-4.20-multi-agent'),
  ('azure_openai-grok-4.3', 'grok-4.3'),
  ('azure_openai-kimi-k2-thinking', 'kimi-k2-thinking'),
  ('azure_openai-kimi-k2.5', 'kimi-k2.5'),
  ('azure_openai-mistral-large-2407', 'mistral-large-2407'),
  ('azure_openai-mistral-large-3', 'mistral-large-3'),
  ('azure_openai-mistral-medium-3-5', 'mistral-medium-3-5'),
  ('azure_openai-phi-3-mini-128k-instruct', 'phi-3-mini-128k-instruct'),
  ('azure_openai-qwen3-32b', 'qwen3-32b'),
  ('azure_openai-qwen3.6-35b-a3b', 'qwen3.6-35b-a3b'),
  ('azure_openai-stable-image-core', 'stable-image-core'),
  ('azure_openai-stable-image-ultra', 'stable-image-ultra'),
  ('bedrock-amazon.nova-2-lite-v1-0', 'nova-2-lite-v1'),
  ('bedrock-anthropic.claude-fable-5', 'claude-fable-5'),
  ('bedrock-anthropic.claude-haiku-4-5-20251001-v1-0', 'claude-haiku-4-5-20251001'),
  ('bedrock-anthropic.claude-opus-4-5-20251101-v1-0', 'claude-opus-4-5-20251101'),
  ('bedrock-anthropic.claude-opus-4-7', 'claude-opus-4-7'),
  ('bedrock-anthropic.claude-opus-4-8', 'claude-opus-4.8'),
  ('bedrock-anthropic.claude-opus-5', 'claude-opus-5'),
  ('bedrock-anthropic.claude-sonnet-4-5-20250929-v1-0', 'claude-sonnet-4-5-20250929'),
  ('bedrock-anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'),
  ('bedrock-anthropic.claude-sonnet-5', 'claude-sonnet-5'),
  ('bedrock-cohere.embed-english-v3', 'embed-english-v3'),
  ('bedrock-cohere.embed-english-v3-0-512', 'embed-english-v3'),
  ('bedrock-cohere.embed-multilingual-v3', 'embed-multilingual-v3'),
  ('bedrock-cohere.embed-multilingual-v3-0-512', 'embed-multilingual-v3'),
  ('bedrock-google.gemma-3-12b-it', 'gemma-3-12b-it'),
  ('bedrock-google.gemma-3-27b-it', 'gemma-3-27b-it'),
  ('bedrock-google.gemma-3-4b-it', 'gemma-3-4b-it'),
  ('bedrock-minimax.minimax-m2', 'minimax-m2'),
  ('bedrock-minimax.minimax-m2.1', 'minimax-m2.1'),
  ('bedrock-minimax.minimax-m2.5', 'minimax-m2.5'),
  ('bedrock-mistral.ministral-3-14b-instruct', 'ministral-14b-2512'),
  ('bedrock-mistral.mistral-large-2407-v1-0', 'mistral-large-2407'),
  ('bedrock-mistral.mixtral-8x7b-instruct-v0-1', 'mixtral-8x7b-instruct'),
  ('bedrock-moonshot.kimi-k2-thinking', 'kimi-k2-thinking'),
  ('bedrock-moonshotai.kimi-k2.5', 'kimi-k2.5'),
  ('bedrock-nvidia.nemotron-nano-12b-v2', 'nemotron-nano-12b-v2'),
  ('bedrock-nvidia.nemotron-nano-3-30b', 'nemotron-3-nano-30b-a3b'),
  ('bedrock-nvidia.nemotron-nano-9b-v2', 'nemotron-nano-9b-v2'),
  ('bedrock-nvidia.nemotron-super-3-120b', 'nemotron-3-super-120b-a12b'),
  ('bedrock-openai.gpt-5.6-luna', 'gpt-5.6-luna'),
  ('bedrock-openai.gpt-5.6-sol', 'gpt-5.6-sol'),
  ('bedrock-openai.gpt-5.6-terra', 'gpt-5.6-terra'),
  ('bedrock-openai.gpt-oss-120b-1-0', 'gpt-oss-120b'),
  ('bedrock-openai.gpt-oss-20b-1-0', 'gpt-oss-20b'),
  ('bedrock-openai.gpt-oss-safeguard-120b', 'gpt-oss-safeguard-120b'),
  ('bedrock-openai.gpt-oss-safeguard-20b', 'gpt-oss-safeguard-20b'),
  ('bedrock-qwen.qwen3-32b-v1-0', 'qwen3-32b'),
  ('bedrock-stability.stable-image-core-v1-1', 'stable-image-core'),
  ('bedrock-stability.stable-image-ultra-v1-1', 'stable-image-ultra'),
  ('bedrock-xai.grok-4.6', 'grok-4.6'),
  ('bedrock-zai.glm-4.7', 'glm-4.7'),
  ('bedrock-zai.glm-4.7-flash', 'glm-4.7-flash'),
  ('bedrock-zai.glm-5', 'glm-5'),
  ('fireworks-models-deepseek-r1', 'deepseek-r1'),
  ('fireworks-models-deepseek-r1-0528', 'deepseek-r1-0528'),
  ('fireworks-models-deepseek-v3', 'deepseek-v3'),
  ('fireworks-models-deepseek-v3-0324', 'deepseek-v3-0324'),
  ('fireworks-models-deepseek-v3p1', 'deepseek-v3.1'),
  ('fireworks-models-deepseek-v3p2', 'deepseek-v3.2'),
  ('fireworks-models-deepseek-v4-flash', 'deepseek-v4-flash'),
  ('fireworks-models-deepseek-v4-flash-0731', 'deepseek-v4-flash-0731'),
  ('fireworks-models-deepseek-v4-pro', 'deepseek-v4-pro'),
  ('fireworks-models-deepseek-v4-pro-0813', 'deepseek-v4-pro-0813'),
  ('fireworks-models-flux-1-schnell', 'flux-1-schnell'),
  ('fireworks-models-flux-1-schnell-fp8', 'flux-1-schnell'),
  ('fireworks-models-gemma-3-12b-it', 'gemma-3-12b-it'),
  ('fireworks-models-gemma-3-27b-it', 'gemma-3-27b-it'),
  ('fireworks-models-gemma-3-4b-it', 'gemma-3-4b-it'),
  ('fireworks-models-gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it'),
  ('fireworks-models-gemma-4-31b-it', 'gemma-4-31b-it'),
  ('fireworks-models-gemma-4-31b-it-nvfp4', 'gemma-4-31b-it'),
  ('fireworks-models-glm-4p7', 'glm-4.7'),
  ('fireworks-models-glm-4p7-flash', 'glm-4.7-flash'),
  ('fireworks-models-glm-5', 'glm-5'),
  ('fireworks-models-glm-5p1', 'glm-5.1'),
  ('fireworks-models-glm-5p2', 'glm-5.2'),
  ('fireworks-models-glm-5p2-fp8', 'glm-5.2'),
  ('fireworks-models-gpt-oss-120b', 'gpt-oss-120b'),
  ('fireworks-models-gpt-oss-20b', 'gpt-oss-20b'),
  ('fireworks-models-gpt-oss-safeguard-120b', 'gpt-oss-safeguard-120b'),
  ('fireworks-models-gpt-oss-safeguard-20b', 'gpt-oss-safeguard-20b'),
  ('fireworks-models-inkling', 'inkling'),
  ('fireworks-models-kimi-k2-instruct-0905', 'kimi-k2-instruct-0905'),
  ('fireworks-models-kimi-k2-thinking', 'kimi-k2-thinking'),
  ('fireworks-models-kimi-k2p5', 'kimi-k2.5'),
  ('fireworks-models-kimi-k2p6', 'kimi-k2.6'),
  ('fireworks-models-kimi-k2p7-code', 'kimi-k2.7-code'),
  ('fireworks-models-kimi-k3', 'kimi-k3'),
  ('fireworks-models-llama-v3p1-8b-instruct', 'llama-v3.1-8b-instruct'),
  ('fireworks-models-minimax-m2', 'minimax-m2'),
  ('fireworks-models-minimax-m2p1', 'minimax-m2.1'),
  ('fireworks-models-minimax-m2p5', 'minimax-m2.5'),
  ('fireworks-models-minimax-m3', 'minimax-m3'),
  ('fireworks-models-ministral-3-3b-instruct-2512', 'ministral-3-3b-instruct-2512'),
  ('fireworks-models-mistral-large-3-fp8', 'mistral-large-3'),
  ('fireworks-models-mixtral-8x7b-instruct', 'mixtral-8x7b-instruct'),
  ('fireworks-models-nemotron-3-super-120b-a12b-bf16', 'nemotron-3-super-120b-a12b'),
  ('fireworks-models-nemotron-3-ultra-bf16', 'nemotron-3-ultra-550b-a55b'),
  ('fireworks-models-nemotron-3-ultra-nvfp4', 'nemotron-3-ultra-550b-a55b'),
  ('fireworks-models-nemotron-lightning-3p5-30b-a3b', 'nemotron-3.5-lightning'),
  ('fireworks-models-nvidia-nemotron-3-super-120b-a12b-fp8', 'nemotron-3-super-120b-a12b'),
  ('fireworks-models-nvidia-nemotron-3-super-120b-a12b-nvfp4', 'nemotron-3-super-120b-a12b'),
  ('fireworks-models-nvidia-nemotron-nano-12b-v2', 'nemotron-nano-12b-v2'),
  ('fireworks-models-nvidia-nemotron-nano-9b-v2', 'nemotron-nano-9b-v2'),
  ('fireworks-models-phi-3-mini-128k-instruct', 'phi-3-mini-128k-instruct'),
  ('fireworks-models-qwen3-14b', 'qwen3-14b'),
  ('fireworks-models-qwen3-32b', 'qwen3-32b'),
  ('fireworks-models-qwen3p5-122b-a10b', 'qwen3.5-122b-a10b'),
  ('fireworks-models-qwen3p5-27b', 'qwen3.5-27b'),
  ('fireworks-models-qwen3p5-35b-a3b', 'qwen3.5-35b-a3b'),
  ('fireworks-models-qwen3p5-397b-a17b', 'qwen3.5-397b-a17b'),
  ('fireworks-models-qwen3p5-4b', 'qwen3.5-4b'),
  ('fireworks-models-qwen3p5-9b', 'qwen3.5-9b'),
  ('fireworks-models-qwen3p6-27b', 'qwen3.6-27b'),
  ('fireworks-models-qwen3p6-35b-a3b', 'qwen3.6-35b-a3b'),
  ('fireworks-models-qwen3p7-max', 'qwen3.7-max'),
  ('fireworks-models-qwen3p7-plus', 'qwen3.7-plus'),
  ('fireworks-models-qwen3p8-27b', 'qwen3.8-27b'),
  ('fireworks-models-qwen3p8-2p4t-a95b', 'qwen3.8-2.4t-a95b'),
  ('fireworks-models-qwen3p8-max', 'qwen3.8-max'),
  ('fireworks-routers-glm-5p2-fast', 'glm-5.2-fast'),
  ('azure_openai-fw-paddleocr-vl-1.6', 'paddleocr-vl-1.6'),
  ('fireworks-models-paddleocr-vl-1-6', 'paddleocr-vl-1.6'),
  ('fireworks-models-nemotron-nano-3-30b-a3b', 'nemotron-3-nano-30b-a3b');

-- 1. Drop the duplicate models' waterfall rungs first: repointing a provider row
--    to the canonical model would otherwise violate the model_waterfalls
--    composite FK (model_id, model_provider_id). The canonical's own chain is
--    rebuilt in step 6.
delete from public.model_waterfalls w
using public.models d, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null and w.model_id = d.id;

-- 2. Adopt a canonical model where none exists yet: rename the best duplicate
--    (active + priced first) into the canonical slug, preserving its discovered
--    metadata (context window, modalities). Curated canonicals already exist and
--    are left untouched.
update public.models mdl
set slug = pick.canonical_slug
from (
  select distinct on (m.canonical_slug)
    m.canonical_slug, d.id as model_id
  from catalog_dedup_map m
  join public.models d on d.slug = m.dup_slug and d.owning_org_id is null
  left join public.model_providers mp on mp.model_id = d.id and mp.owning_org_id is null
  where not exists (
    select 1 from public.models c where c.slug = m.canonical_slug and c.owning_org_id is null
  )
  order by m.canonical_slug,
    (mp.status = 'active') desc nulls last,
    (mp.input_micro_usd_per_million is not null) desc,
    d.slug
) pick
where mdl.id = pick.model_id and mdl.owning_org_id is null;

-- 3. Repoint each remaining duplicate's provider rows onto the canonical model,
--    unless the canonical already carries that (provider, wire, base_url) route.
update public.model_providers mp
set model_id = c.id
from public.models d, public.models c, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and c.slug = m.canonical_slug and c.owning_org_id is null
  and mp.model_id = d.id and mp.owning_org_id is null
  and d.id <> c.id
  and not exists (
    select 1 from public.model_providers x
    where x.model_id = c.id and x.provider = mp.provider
      and x.provider_model_id = mp.provider_model_id and x.owning_org_id is null
      and x.base_url is not distinct from mp.base_url
  );

-- 4. Delete duplicate provider rows that could not move (the canonical already
--    had that exact route) — they are now redundant.
delete from public.model_providers mp
using public.models d, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and mp.model_id = d.id and mp.owning_org_id is null;

-- 5. Delete the now-empty duplicate model rows (never a curated/preferred row,
--    never one that still has a provider lane).
delete from public.models d
using catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and d.preferred_rank is null
  and not exists (select 1 from public.model_providers mp where mp.model_id = d.id);

-- 6. Rebuild a rung-0 default chain for any canonical left without one (a newly
--    adopted canonical whose discovered chain was dropped in step 1). Points at
--    the canonical's best active, priced lane.
insert into public.model_waterfalls (model_id, position, model_provider_id)
select distinct on (c.id) c.id, 0, mp.id
from catalog_dedup_map m
join public.models c on c.slug = m.canonical_slug and c.owning_org_id is null
join public.model_providers mp on mp.model_id = c.id and mp.owning_org_id is null
where not exists (
  select 1 from public.model_waterfalls w
  where w.model_id = c.id and w.org_id is null and w.position = 0
)
order by c.id,
  (mp.status = 'active') desc,
  (mp.input_micro_usd_per_million is not null) desc,
  mp.id
on conflict (model_id, org_id, position) do nothing;

drop table catalog_dedup_map;
