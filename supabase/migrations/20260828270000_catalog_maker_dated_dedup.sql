-- Copyright (c) 2026 Experiential Labs. All rights reserved.
--
-- Anthropic-family grind + same-class catalog sweep (r3, the product owner: "the anthropic
-- models are a mess"). Two failure classes left after the 20260828250000
-- cross-provider dedup, judged per maker with live-listing evidence:
--
-- 1. MAKER-DATED IDS beside their base. Anthropic stamps its CANONICAL API ids
--    with a date (its own /v1/models displays claude-opus-4-5-20251101 as
--    "Claude Opus 4.5"), and OpenAI's <base>-YYYY-MM-DD ids are snapshots of
--    the base model — for these makers a dated id merges onto its base,
--    overriding the generic keep-dated-separate rule (which still holds for
--    everyone else: DeepSeek -0731 builds stay their own models). Also folds
--    Anthropic's dash-spelled minors (claude-opus-4-7 == claude-opus-4.7),
--    Azure's "-2" re-registration artifacts (verified: no x.2 Claude exists on
--    Anthropic's or OpenRouter's live listings), and Azure Foundry's
--    -YYYY-MM-DD registration stamps (Kimi-K2.6-2026-04-20 IS kimi-k2.6).
-- 2. PROVIDER-PREFIXED ORPHANS (azure_openai-claude-*, bedrock-anthropic.*)
--    that duplicate a canonical, plus their lane-decorated display names —
--    provider provenance belongs on the provider lane, never the model name.
--
-- The map below keys on BOTH spellings a duplicate may carry (the legacy
-- provider-prefixed slug still in production and the canonicalized slug a
-- re-synced environment mints), so it is environment-independent; every key
-- that does not exist is a no-op. FK-safe and idempotent like 20260828250000,
-- with two refinements: adoption runs FIRST (a rename changes no ids, so an
-- adopted canonical keeps ALL its chains — default and org overrides), and a
-- dissolving duplicate's ORG overrides are captured and re-created on the
-- canonical instead of being dropped. The forward-fix lives in
-- explabs/gateway/model_aliases.py (maker rules the daily sync inherits), so
-- these duplicates cannot re-appear.

create temporary table catalog_dedup_map (
  dup_slug text primary key,
  canonical_slug text not null
);
insert into catalog_dedup_map (dup_slug, canonical_slug) values
  ('aoai-sora-2025-02-28', 'aoai-sora'),
  ('azure_openai-aoai-sora-2025-02-28', 'aoai-sora'),
  ('azure_openai-claude-haiku-4-5', 'claude-haiku-4.5'),
  ('azure_openai-claude-haiku-4-5-2', 'claude-haiku-4.5'),
  ('azure_openai-claude-haiku-4-5-20251001', 'claude-haiku-4.5'),
  ('azure_openai-claude-opus-4-1', 'claude-opus-4.1'),
  ('azure_openai-claude-opus-4-1-20250805', 'claude-opus-4.1'),
  ('azure_openai-claude-opus-4-5', 'claude-opus-4.5'),
  ('azure_openai-claude-opus-4-5-20251101', 'claude-opus-4.5'),
  ('azure_openai-claude-opus-4-6', 'claude-opus-4.6'),
  ('azure_openai-claude-opus-4-7', 'claude-opus-4.7'),
  ('azure_openai-claude-opus-4-8', 'claude-opus-4.8'),
  ('azure_openai-claude-opus-4-8-2', 'claude-opus-4.8'),
  ('azure_openai-claude-opus-5-2', 'claude-opus-5'),
  ('azure_openai-claude-sonnet-4-5', 'claude-sonnet-4.5'),
  ('azure_openai-claude-sonnet-4-5-20250929', 'claude-sonnet-4.5'),
  ('azure_openai-claude-sonnet-4-6', 'claude-sonnet-4.6'),
  ('azure_openai-claude-sonnet-5-2', 'claude-sonnet-5'),
  ('azure_openai-codex-mini-2025-05-16', 'codex-mini'),
  ('azure_openai-computer-use-preview-2025-04-15', 'computer-use-preview'),
  ('azure_openai-deepseek-v3.1', 'deepseek-v3.1'),
  ('azure_openai-deepseek-v3.2', 'deepseek-v3.2'),
  ('azure_openai-deepseek-v4-flash-0731-2026-07-31', 'deepseek-v4-flash-0731'),
  ('azure_openai-deepseek-v4-flash-2026-04-23', 'deepseek-v4-flash'),
  ('azure_openai-deepseek-v4-pro-2026-04-23', 'deepseek-v4-pro'),
  ('azure_openai-fw-deepseek-v3.1', 'deepseek-v3.1'),
  ('azure_openai-fw-deepseek-v3.2', 'deepseek-v3.2'),
  ('azure_openai-fw-gemma-4-31b-it', 'gemma-4-31b-it'),
  ('azure_openai-fw-glm-4.7', 'glm-4.7'),
  ('azure_openai-fw-glm-5.1', 'glm-5.1'),
  ('azure_openai-fw-glm-5.2', 'glm-5.2'),
  ('azure_openai-fw-glm-5.2-fast', 'glm-5.2-fast'),
  ('azure_openai-fw-gpt-oss-120b', 'gpt-oss-120b'),
  ('azure_openai-fw-gpt-oss-20b', 'gpt-oss-20b'),
  ('azure_openai-fw-kimi-k2.5', 'kimi-k2.5'),
  ('azure_openai-fw-kimi-k2.6', 'kimi-k2.6'),
  ('azure_openai-fw-kimi-k2.7-code', 'kimi-k2.7-code'),
  ('azure_openai-fw-llama-v3.1-8b-instruct', 'llama-v3.1-8b-instruct'),
  ('azure_openai-fw-minimax-m2.5', 'minimax-m2.5'),
  ('azure_openai-fw-nemotron-3-super-120b-a12b-bf16', 'nemotron-3-super-120b-a12b'),
  ('azure_openai-fw-nemotron-3-ultra-nvfp4', 'nemotron-3-ultra-550b-a55b'),
  ('azure_openai-fw-nemotron-lightning-3.5-30b-a3b', 'nemotron-3.5-lightning'),
  ('azure_openai-fw-paddleocr-vl-1.6', 'paddleocr-vl-1.6'),
  ('azure_openai-fw-qwen3.5-122b-a10b', 'qwen3.5-122b-a10b'),
  ('azure_openai-fw-qwen3.5-27b', 'qwen3.5-27b'),
  ('azure_openai-fw-qwen3.5-35b-a3b', 'qwen3.5-35b-a3b'),
  ('azure_openai-fw-qwen3.5-397b-a17b', 'qwen3.5-397b-a17b'),
  ('azure_openai-fw-qwen3.5-4b', 'qwen3.5-4b'),
  ('azure_openai-fw-qwen3.5-9b', 'qwen3.5-9b'),
  ('azure_openai-fw-qwen3.6-27b', 'qwen3.6-27b'),
  ('azure_openai-fw-qwen3.6-35b-a3b', 'qwen3.6-35b-a3b'),
  ('azure_openai-gpt-4-turbo-2024-04-09', 'gpt-4-turbo'),
  ('azure_openai-gpt-4.1-2025-04-14', 'gpt-4.1'),
  ('azure_openai-gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'),
  ('azure_openai-gpt-4.1-nano-2025-04-14', 'gpt-4.1-nano'),
  ('azure_openai-gpt-4.5-preview-2025-02-27', 'gpt-4.5-preview'),
  ('azure_openai-gpt-4o-2024-05-13', 'gpt-4o'),
  ('azure_openai-gpt-4o-2024-08-06', 'gpt-4o'),
  ('azure_openai-gpt-4o-2024-11-20', 'gpt-4o'),
  ('azure_openai-gpt-4o-audio-preview-2024-10-01', 'gpt-4o-audio-preview'),
  ('azure_openai-gpt-4o-audio-preview-2024-12-17', 'gpt-4o-audio-preview'),
  ('azure_openai-gpt-4o-audio-preview-2025-06-03', 'gpt-4o-audio-preview'),
  ('azure_openai-gpt-4o-canvas-2024-09-25', 'gpt-4o-canvas'),
  ('azure_openai-gpt-4o-mini-2024-07-18', 'gpt-4o-mini'),
  ('azure_openai-gpt-4o-mini-audio-preview-2024-12-17', 'gpt-4o-mini-audio-preview'),
  ('azure_openai-gpt-4o-mini-realtime-preview-2024-12-17', 'gpt-4o-mini-realtime-preview'),
  ('azure_openai-gpt-4o-mini-transcribe-2025-03-20', 'gpt-4o-mini-transcribe'),
  ('azure_openai-gpt-4o-mini-transcribe-2025-12-15', 'gpt-4o-mini-transcribe'),
  ('azure_openai-gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts'),
  ('azure_openai-gpt-4o-mini-tts-2025-12-15', 'gpt-4o-mini-tts'),
  ('azure_openai-gpt-4o-realtime-preview-2024-12-17', 'gpt-4o-realtime-preview'),
  ('azure_openai-gpt-4o-realtime-preview-2025-06-03', 'gpt-4o-realtime-preview'),
  ('azure_openai-gpt-4o-transcribe-2025-03-20', 'gpt-4o-transcribe'),
  ('azure_openai-gpt-4o-transcribe-diarize-2025-10-15', 'gpt-4o-transcribe-diarize'),
  ('azure_openai-gpt-5-2025-08-07', 'gpt-5'),
  ('azure_openai-gpt-5-chat-2025-08-07', 'gpt-5-chat'),
  ('azure_openai-gpt-5-chat-2025-08-15', 'gpt-5-chat'),
  ('azure_openai-gpt-5-chat-2025-10-03', 'gpt-5-chat'),
  ('azure_openai-gpt-5-codex-2025-09-15', 'gpt-5-codex'),
  ('azure_openai-gpt-5-mini-2025-08-07', 'gpt-5-mini'),
  ('azure_openai-gpt-5-mini-lite-2025-08-07', 'gpt-5-mini-lite'),
  ('azure_openai-gpt-5-nano-2025-08-07', 'gpt-5-nano'),
  ('azure_openai-gpt-5-pro-2025-10-06', 'gpt-5-pro'),
  ('azure_openai-gpt-5.1-2025-11-13', 'gpt-5.1'),
  ('azure_openai-gpt-5.1-chat-2025-11-13', 'gpt-5.1-chat'),
  ('azure_openai-gpt-5.1-codex-2025-11-13', 'gpt-5.1-codex'),
  ('azure_openai-gpt-5.1-codex-max-2025-12-04', 'gpt-5.1-codex-max'),
  ('azure_openai-gpt-5.1-codex-mini-2025-11-13', 'gpt-5.1-codex-mini'),
  ('azure_openai-gpt-5.2-2025-12-11', 'gpt-5.2'),
  ('azure_openai-gpt-5.2-chat-2025-12-11', 'gpt-5.2-chat'),
  ('azure_openai-gpt-5.2-chat-2026-02-10', 'gpt-5.2-chat'),
  ('azure_openai-gpt-5.2-codex-2026-01-14', 'gpt-5.2-codex'),
  ('azure_openai-gpt-5.3-chat-2026-03-03', 'gpt-5.3-chat'),
  ('azure_openai-gpt-5.3-codex-2026-02-20', 'gpt-5.3-codex'),
  ('azure_openai-gpt-5.3-codex-2026-02-24', 'gpt-5.3-codex'),
  ('azure_openai-gpt-5.4-2026-03-05', 'gpt-5.4'),
  ('azure_openai-gpt-5.4-mini-2026-03-17', 'gpt-5.4-mini'),
  ('azure_openai-gpt-5.4-nano-2026-03-17', 'gpt-5.4-nano'),
  ('azure_openai-gpt-5.4-pro-2026-03-05', 'gpt-5.4-pro'),
  ('azure_openai-gpt-5.5-2026-04-24', 'gpt-5.5'),
  ('azure_openai-gpt-5.6-luna-2026-07-09', 'gpt-5.6-luna'),
  ('azure_openai-gpt-5.6-sol-2026-07-09', 'gpt-5.6-sol'),
  ('azure_openai-gpt-5.6-terra-2026-07-09', 'gpt-5.6-terra'),
  ('azure_openai-gpt-audio-1.5-2026-02-23', 'gpt-audio-1.5'),
  ('azure_openai-gpt-audio-2025-08-28', 'gpt-audio'),
  ('azure_openai-gpt-audio-mini-2025-10-06', 'gpt-audio-mini'),
  ('azure_openai-gpt-audio-mini-2025-12-15', 'gpt-audio-mini'),
  ('azure_openai-gpt-chat-latest-2026-05-05', 'gpt-chat-latest'),
  ('azure_openai-gpt-chat-latest-2026-05-28', 'gpt-chat-latest'),
  ('azure_openai-gpt-chat-latest-2026-06-24', 'gpt-chat-latest'),
  ('azure_openai-gpt-chat-latest-2026-08-06', 'gpt-chat-latest'),
  ('azure_openai-gpt-image-1-2025-04-15', 'gpt-image-1'),
  ('azure_openai-gpt-image-1-mini-2025-10-06', 'gpt-image-1-mini'),
  ('azure_openai-gpt-image-1.5-2025-12-16', 'gpt-image-1.5'),
  ('azure_openai-gpt-image-2-2026-04-21', 'gpt-image-2'),
  ('azure_openai-gpt-live-transcribe-2026-07-28', 'gpt-live-transcribe'),
  ('azure_openai-gpt-offline-whisper-1-2026-07-27', 'gpt-offline-whisper-1'),
  ('azure_openai-gpt-oss-120b', 'gpt-oss-120b'),
  ('azure_openai-gpt-oss-20b', 'gpt-oss-20b'),
  ('azure_openai-gpt-realtime-1.5-2026-02-23', 'gpt-realtime-1.5'),
  ('azure_openai-gpt-realtime-2-2026-05-06', 'gpt-realtime-2'),
  ('azure_openai-gpt-realtime-2.1-2026-07-07', 'gpt-realtime-2.1'),
  ('azure_openai-gpt-realtime-2.1-mini-2026-07-07', 'gpt-realtime-2.1-mini'),
  ('azure_openai-gpt-realtime-2025-08-28', 'gpt-realtime'),
  ('azure_openai-gpt-realtime-mini-2025-10-06', 'gpt-realtime-mini'),
  ('azure_openai-gpt-realtime-mini-2025-12-15', 'gpt-realtime-mini'),
  ('azure_openai-gpt-realtime-translate-2026-05-06', 'gpt-realtime-translate'),
  ('azure_openai-gpt-realtime-whisper-2-2026-07-27', 'gpt-realtime-whisper-2'),
  ('azure_openai-gpt-realtime-whisper-2026-05-06', 'gpt-realtime-whisper'),
  ('azure_openai-gpt-transcribe-2026-07-28', 'gpt-transcribe'),
  ('azure_openai-grok-4-20-reasoning', 'grok-4.20-multi-agent'),
  ('azure_openai-kimi-k2.5', 'kimi-k2.5'),
  ('azure_openai-kimi-k2.6-2026-04-20', 'kimi-k2.6'),
  ('azure_openai-kimi-k2.7-code-2026-06-12', 'kimi-k2.7-code'),
  ('azure_openai-mai-image-2-2026-02-20', 'mai-image-2'),
  ('azure_openai-mai-image-2.5-2026-06-02', 'mai-image-2.5'),
  ('azure_openai-mai-image-2.5-flash-2026-06-02', 'mai-image-2.5-flash'),
  ('azure_openai-mai-image-2.5-pro-2026-06-19', 'mai-image-2.5-pro'),
  ('azure_openai-mai-image-2e-2026-04-09', 'mai-image-2e'),
  ('azure_openai-mai-m365-2026-04-27', 'mai-m365'),
  ('azure_openai-mai-thinking-1-2026-06-01', 'mai-thinking-1'),
  ('azure_openai-mistral-large-3', 'mistral-large-3'),
  ('azure_openai-model-router-2025-05-19', 'model-router'),
  ('azure_openai-model-router-2025-08-07', 'model-router'),
  ('azure_openai-model-router-2025-11-18', 'model-router'),
  ('azure_openai-o1-2024-12-17', 'o1'),
  ('azure_openai-o1-mini-2024-09-12', 'o1-mini'),
  ('azure_openai-o1-preview-2024-09-12', 'o1-preview'),
  ('azure_openai-o1-pro-2025-03-19', 'o1-pro'),
  ('azure_openai-o3-2025-04-16', 'o3'),
  ('azure_openai-o3-deep-research-2025-06-26', 'o3-deep-research'),
  ('azure_openai-o3-mini-2025-01-31', 'o3-mini'),
  ('azure_openai-o3-mini-alpha-2024-12-17', 'o3-mini-alpha'),
  ('azure_openai-o3-pro-2025-06-10', 'o3-pro'),
  ('azure_openai-o4-mini-2025-04-16', 'o4-mini'),
  ('azure_openai-qwen3.6-35b-a3b', 'qwen3.6-35b-a3b'),
  ('azure_openai-sora-2-2025-10-06', 'sora-2'),
  ('azure_openai-sora-2-2025-12-08', 'sora-2'),
  ('azure_openai-sora-2025-05-02', 'sora'),
  ('bedrock-amazon.nova-2-lite-v1-0', 'nova-2-lite-v1'),
  ('bedrock-anthropic.claude-haiku-4-5-20251001-v1-0', 'claude-haiku-4.5'),
  ('bedrock-anthropic.claude-opus-4-5-20251101-v1-0', 'claude-opus-4.5'),
  ('bedrock-anthropic.claude-opus-4-6-v1', 'claude-opus-4.6'),
  ('bedrock-anthropic.claude-opus-4-7', 'claude-opus-4.7'),
  ('bedrock-anthropic.claude-opus-4-8', 'claude-opus-4.8'),
  ('bedrock-anthropic.claude-sonnet-4-5-20250929-v1-0', 'claude-sonnet-4.5'),
  ('bedrock-anthropic.claude-sonnet-4-6', 'claude-sonnet-4.6'),
  ('bedrock-cohere.embed-english-v3', 'embed-english-v3'),
  ('bedrock-cohere.embed-english-v3-0-512', 'embed-english-v3'),
  ('bedrock-cohere.embed-multilingual-v3', 'embed-multilingual-v3'),
  ('bedrock-cohere.embed-multilingual-v3-0-512', 'embed-multilingual-v3'),
  ('bedrock-minimax.minimax-m2.1', 'minimax-m2.1'),
  ('bedrock-minimax.minimax-m2.5', 'minimax-m2.5'),
  ('bedrock-mistral.ministral-3-14b-instruct', 'ministral-14b-2512'),
  ('bedrock-moonshotai.kimi-k2.5', 'kimi-k2.5'),
  ('bedrock-nvidia.nemotron-nano-12b-v2', 'nemotron-nano-12b-v2'),
  ('bedrock-nvidia.nemotron-nano-3-30b', 'nemotron-3-nano-30b-a3b'),
  ('bedrock-nvidia.nemotron-nano-9b-v2', 'nemotron-nano-9b-v2'),
  ('bedrock-nvidia.nemotron-super-3-120b', 'nemotron-3-super-120b-a12b'),
  ('bedrock-openai.gpt-oss-120b-1-0', 'gpt-oss-120b'),
  ('bedrock-openai.gpt-oss-20b-1-0', 'gpt-oss-20b'),
  ('bedrock-xai.grok-4.6', 'grok-4.6'),
  ('bedrock-zai.glm-4.7', 'glm-4.7'),
  ('bedrock-zai.glm-4.7-flash', 'glm-4.7-flash'),
  ('claude-haiku-4-5-2', 'claude-haiku-4.5'),
  ('claude-haiku-4-5-20251001', 'claude-haiku-4.5'),
  ('claude-opus-4-1', 'claude-opus-4.1'),
  ('claude-opus-4-1-20250805', 'claude-opus-4.1'),
  ('claude-opus-4-5', 'claude-opus-4.5'),
  ('claude-opus-4-5-20251101', 'claude-opus-4.5'),
  ('claude-opus-4-6', 'claude-opus-4.6'),
  ('claude-opus-4-6-v1', 'claude-opus-4.6'),
  ('claude-opus-4-7', 'claude-opus-4.7'),
  ('claude-opus-4-8-2', 'claude-opus-4.8'),
  ('claude-opus-5-2', 'claude-opus-5'),
  ('claude-sonnet-4-5', 'claude-sonnet-4.5'),
  ('claude-sonnet-4-5-20250929', 'claude-sonnet-4.5'),
  ('claude-sonnet-4-6', 'claude-sonnet-4.6'),
  ('claude-sonnet-5-2', 'claude-sonnet-5'),
  ('codex-mini-2025-05-16', 'codex-mini'),
  ('computer-use-preview-2025-04-15', 'computer-use-preview'),
  ('deepseek-v4-flash-0731-2026-07-31', 'deepseek-v4-flash-0731'),
  ('deepseek-v4-flash-2026-04-23', 'deepseek-v4-flash'),
  ('deepseek-v4-pro-2026-04-23', 'deepseek-v4-pro'),
  ('fireworks-models-deepseek-v3p1', 'deepseek-v3.1'),
  ('fireworks-models-deepseek-v3p2', 'deepseek-v3.2'),
  ('fireworks-models-flux-1-schnell', 'flux-1-schnell'),
  ('fireworks-models-flux-1-schnell-fp8', 'flux-1-schnell'),
  ('fireworks-models-gemma-4-31b-it', 'gemma-4-31b-it'),
  ('fireworks-models-gemma-4-31b-it-nvfp4', 'gemma-4-31b-it'),
  ('fireworks-models-glm-4p7', 'glm-4.7'),
  ('fireworks-models-glm-4p7-flash', 'glm-4.7-flash'),
  ('fireworks-models-glm-5p1', 'glm-5.1'),
  ('fireworks-models-glm-5p2', 'glm-5.2'),
  ('fireworks-models-glm-5p2-fp8', 'glm-5.2'),
  ('fireworks-models-gpt-oss-120b', 'gpt-oss-120b'),
  ('fireworks-models-gpt-oss-20b', 'gpt-oss-20b'),
  ('fireworks-models-kimi-k2p5', 'kimi-k2.5'),
  ('fireworks-models-kimi-k2p6', 'kimi-k2.6'),
  ('fireworks-models-kimi-k2p7-code', 'kimi-k2.7-code'),
  ('fireworks-models-llama-v3p1-8b-instruct', 'llama-v3.1-8b-instruct'),
  ('fireworks-models-minimax-m2p1', 'minimax-m2.1'),
  ('fireworks-models-minimax-m2p5', 'minimax-m2.5'),
  ('fireworks-models-mistral-large-3-fp8', 'mistral-large-3'),
  ('fireworks-models-nemotron-3-super-120b-a12b-bf16', 'nemotron-3-super-120b-a12b'),
  ('fireworks-models-nemotron-3-ultra-bf16', 'nemotron-3-ultra-550b-a55b'),
  ('fireworks-models-nemotron-3-ultra-nvfp4', 'nemotron-3-ultra-550b-a55b'),
  ('fireworks-models-nemotron-lightning-3p5-30b-a3b', 'nemotron-3.5-lightning'),
  ('fireworks-models-nemotron-nano-3-30b-a3b', 'nemotron-3-nano-30b-a3b'),
  ('fireworks-models-nvidia-nemotron-3-super-120b-a12b-fp8', 'nemotron-3-super-120b-a12b'),
  ('fireworks-models-nvidia-nemotron-3-super-120b-a12b-nvfp4', 'nemotron-3-super-120b-a12b'),
  ('fireworks-models-nvidia-nemotron-nano-12b-v2', 'nemotron-nano-12b-v2'),
  ('fireworks-models-nvidia-nemotron-nano-9b-v2', 'nemotron-nano-9b-v2'),
  ('fireworks-models-paddleocr-vl-1-6', 'paddleocr-vl-1.6'),
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
  ('gpt-4-turbo-2024-04-09', 'gpt-4-turbo'),
  ('gpt-4.1-2025-04-14', 'gpt-4.1'),
  ('gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'),
  ('gpt-4.1-nano-2025-04-14', 'gpt-4.1-nano'),
  ('gpt-4.5-preview-2025-02-27', 'gpt-4.5-preview'),
  ('gpt-4o-2024-05-13', 'gpt-4o'),
  ('gpt-4o-2024-08-06', 'gpt-4o'),
  ('gpt-4o-2024-11-20', 'gpt-4o'),
  ('gpt-4o-audio-preview-2024-10-01', 'gpt-4o-audio-preview'),
  ('gpt-4o-audio-preview-2024-12-17', 'gpt-4o-audio-preview'),
  ('gpt-4o-audio-preview-2025-06-03', 'gpt-4o-audio-preview'),
  ('gpt-4o-canvas-2024-09-25', 'gpt-4o-canvas'),
  ('gpt-4o-mini-2024-07-18', 'gpt-4o-mini'),
  ('gpt-4o-mini-audio-preview-2024-12-17', 'gpt-4o-mini-audio-preview'),
  ('gpt-4o-mini-realtime-preview-2024-12-17', 'gpt-4o-mini-realtime-preview'),
  ('gpt-4o-mini-transcribe-2025-03-20', 'gpt-4o-mini-transcribe'),
  ('gpt-4o-mini-transcribe-2025-12-15', 'gpt-4o-mini-transcribe'),
  ('gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts'),
  ('gpt-4o-mini-tts-2025-12-15', 'gpt-4o-mini-tts'),
  ('gpt-4o-realtime-preview-2024-12-17', 'gpt-4o-realtime-preview'),
  ('gpt-4o-realtime-preview-2025-06-03', 'gpt-4o-realtime-preview'),
  ('gpt-4o-transcribe-2025-03-20', 'gpt-4o-transcribe'),
  ('gpt-4o-transcribe-diarize-2025-10-15', 'gpt-4o-transcribe-diarize'),
  ('gpt-5-2025-08-07', 'gpt-5'),
  ('gpt-5-chat-2025-08-07', 'gpt-5-chat'),
  ('gpt-5-chat-2025-08-15', 'gpt-5-chat'),
  ('gpt-5-chat-2025-10-03', 'gpt-5-chat'),
  ('gpt-5-codex-2025-09-15', 'gpt-5-codex'),
  ('gpt-5-mini-2025-08-07', 'gpt-5-mini'),
  ('gpt-5-mini-lite-2025-08-07', 'gpt-5-mini-lite'),
  ('gpt-5-nano-2025-08-07', 'gpt-5-nano'),
  ('gpt-5-pro-2025-10-06', 'gpt-5-pro'),
  ('gpt-5.1-2025-11-13', 'gpt-5.1'),
  ('gpt-5.1-chat-2025-11-13', 'gpt-5.1-chat'),
  ('gpt-5.1-codex-2025-11-13', 'gpt-5.1-codex'),
  ('gpt-5.1-codex-max-2025-12-04', 'gpt-5.1-codex-max'),
  ('gpt-5.1-codex-mini-2025-11-13', 'gpt-5.1-codex-mini'),
  ('gpt-5.2-2025-12-11', 'gpt-5.2'),
  ('gpt-5.2-chat-2025-12-11', 'gpt-5.2-chat'),
  ('gpt-5.2-chat-2026-02-10', 'gpt-5.2-chat'),
  ('gpt-5.2-codex-2026-01-14', 'gpt-5.2-codex'),
  ('gpt-5.3-chat-2026-03-03', 'gpt-5.3-chat'),
  ('gpt-5.3-codex-2026-02-20', 'gpt-5.3-codex'),
  ('gpt-5.3-codex-2026-02-24', 'gpt-5.3-codex'),
  ('gpt-5.4-2026-03-05', 'gpt-5.4'),
  ('gpt-5.4-mini-2026-03-17', 'gpt-5.4-mini'),
  ('gpt-5.4-nano-2026-03-17', 'gpt-5.4-nano'),
  ('gpt-5.4-pro-2026-03-05', 'gpt-5.4-pro'),
  ('gpt-5.5-2026-04-24', 'gpt-5.5'),
  ('gpt-5.6-luna-2026-07-09', 'gpt-5.6-luna'),
  ('gpt-5.6-sol-2026-07-09', 'gpt-5.6-sol'),
  ('gpt-5.6-terra-2026-07-09', 'gpt-5.6-terra'),
  ('gpt-audio-1.5-2026-02-23', 'gpt-audio-1.5'),
  ('gpt-audio-2025-08-28', 'gpt-audio'),
  ('gpt-audio-mini-2025-10-06', 'gpt-audio-mini'),
  ('gpt-audio-mini-2025-12-15', 'gpt-audio-mini'),
  ('gpt-chat-latest-2026-05-05', 'gpt-chat-latest'),
  ('gpt-chat-latest-2026-05-28', 'gpt-chat-latest'),
  ('gpt-chat-latest-2026-06-24', 'gpt-chat-latest'),
  ('gpt-chat-latest-2026-08-06', 'gpt-chat-latest'),
  ('gpt-image-1-2025-04-15', 'gpt-image-1'),
  ('gpt-image-1-mini-2025-10-06', 'gpt-image-1-mini'),
  ('gpt-image-1.5-2025-12-16', 'gpt-image-1.5'),
  ('gpt-image-2-2026-04-21', 'gpt-image-2'),
  ('gpt-live-transcribe-2026-07-28', 'gpt-live-transcribe'),
  ('gpt-offline-whisper-1-2026-07-27', 'gpt-offline-whisper-1'),
  ('gpt-realtime-1.5-2026-02-23', 'gpt-realtime-1.5'),
  ('gpt-realtime-2-2026-05-06', 'gpt-realtime-2'),
  ('gpt-realtime-2.1-2026-07-07', 'gpt-realtime-2.1'),
  ('gpt-realtime-2.1-mini-2026-07-07', 'gpt-realtime-2.1-mini'),
  ('gpt-realtime-2025-08-28', 'gpt-realtime'),
  ('gpt-realtime-mini-2025-10-06', 'gpt-realtime-mini'),
  ('gpt-realtime-mini-2025-12-15', 'gpt-realtime-mini'),
  ('gpt-realtime-translate-2026-05-06', 'gpt-realtime-translate'),
  ('gpt-realtime-whisper-2-2026-07-27', 'gpt-realtime-whisper-2'),
  ('gpt-realtime-whisper-2026-05-06', 'gpt-realtime-whisper'),
  ('gpt-transcribe-2026-07-28', 'gpt-transcribe'),
  ('kimi-k2.6-2026-04-20', 'kimi-k2.6'),
  ('kimi-k2.7-code-2026-06-12', 'kimi-k2.7-code'),
  ('mai-image-2-2026-02-20', 'mai-image-2'),
  ('mai-image-2.5-2026-06-02', 'mai-image-2.5'),
  ('mai-image-2.5-flash-2026-06-02', 'mai-image-2.5-flash'),
  ('mai-image-2.5-pro-2026-06-19', 'mai-image-2.5-pro'),
  ('mai-image-2e-2026-04-09', 'mai-image-2e'),
  ('mai-m365-2026-04-27', 'mai-m365'),
  ('mai-thinking-1-2026-06-01', 'mai-thinking-1'),
  ('model-router-2025-05-19', 'model-router'),
  ('model-router-2025-08-07', 'model-router'),
  ('model-router-2025-11-18', 'model-router'),
  ('o1-2024-12-17', 'o1'),
  ('o1-mini-2024-09-12', 'o1-mini'),
  ('o1-preview-2024-09-12', 'o1-preview'),
  ('o1-pro-2025-03-19', 'o1-pro'),
  ('o3-2025-04-16', 'o3'),
  ('o3-deep-research-2025-06-26', 'o3-deep-research'),
  ('o3-mini-2025-01-31', 'o3-mini'),
  ('o3-mini-alpha-2024-12-17', 'o3-mini-alpha'),
  ('o3-pro-2025-06-10', 'o3-pro'),
  ('o4-mini-2025-04-16', 'o4-mini'),
  ('sora-2-2025-10-06', 'sora-2'),
  ('sora-2-2025-12-08', 'sora-2'),
  ('sora-2025-05-02', 'sora');

-- 1. Capture EVERY organization waterfall override held on a duplicate —
--    including the one that will be adopted below — keyed by route identity so
--    the org's rungs from ALL duplicates of one canonical can be merged and
--    renumbered into a single chain in step 8. Captured rungs are removed here;
--    only true pre-existing overrides on an already-canonical model remain.
create temporary table dedup_org_overrides as
select w.org_id, m.canonical_slug, w.position,
       mp.provider, mp.provider_model_id, mp.base_url, mp.owning_org_id
from public.model_waterfalls w
join public.models d on d.id = w.model_id and d.owning_org_id is null
join catalog_dedup_map m on m.dup_slug = d.slug
join public.model_providers mp on mp.id = w.model_provider_id
where w.org_id is not null;

delete from public.model_waterfalls w
using public.models d, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and w.model_id = d.id and w.org_id is not null;

-- 2. Adopt a canonical model where none exists yet: rename the best duplicate
--    (active + priced first) into the canonical slug. Renaming changes no ids,
--    so the adopted model keeps its DEFAULT chain; its org overrides were
--    captured above and rejoin the merged chain in step 8.
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

-- 3. Drop the dissolving duplicates' waterfall rungs: repointing a provider row
--    to the canonical model would otherwise violate the model_waterfalls
--    composite FK (model_id, model_provider_id). Default chains are rebuilt in
--    step 7 and the captured org overrides re-created in step 8.
delete from public.model_waterfalls w
using public.models d, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null and w.model_id = d.id;

-- 4. Repoint each dissolving duplicate's provider rows onto the canonical
--    model, unless the canonical already carries that exact route. Org-owned
--    lanes (a local variant an org added on the duplicate) move too — a PUBLIC
--    canonical admits org-owned deployments, and leaving one behind would
--    strand it on a deleted model and lose the org's rung.
update public.model_providers mp
set model_id = c.id
from public.models d, public.models c, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and c.slug = m.canonical_slug and c.owning_org_id is null
  and mp.model_id = d.id
  and d.id <> c.id
  and not exists (
    select 1 from public.model_providers x
    where x.model_id = c.id and x.provider = mp.provider
      and x.provider_model_id = mp.provider_model_id
      and x.owning_org_id is not distinct from mp.owning_org_id
      and x.base_url is not distinct from mp.base_url
  );

-- 5. Delete duplicate provider rows that could not move (exact-route collision).
delete from public.model_providers mp
using public.models d, catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and mp.model_id = d.id;

-- 6. Delete the now-empty duplicate model rows (never curated, never one that
--    still has a lane).
delete from public.models d
using catalog_dedup_map m
where d.slug = m.dup_slug and d.owning_org_id is null
  and d.preferred_rank is null
  and not exists (select 1 from public.model_providers mp where mp.model_id = d.id);

-- 7. Rebuild a rung-0 default chain for any canonical left without one.
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

-- 8. Re-create the captured org overrides on the canonical, pointing at each
--    route's new home — but only for an org with NO pre-existing override of
--    its own on the canonical (two configured orderings are never interleaved;
--    the canonical's own configuration wins). A route that was dropped as an
--    exact duplicate re-anchors on the canonical's identical surviving route.
--    Positions are RENUMBERED densely per (canonical, org): when one org held
--    overrides on several duplicates that collapse onto one canonical, their
--    independently assigned positions would collide and on-conflict would
--    silently drop rungs — instead every captured rung survives, each source
--    chain's relative order preserved (ties across chains break on route id),
--    and each route appears at most once per chain.
with resolved as (
  select distinct on (c.id, o.org_id, mp.id)
    c.id as model_id, o.org_id, mp.id as route_id, o.position as src_position
  from dedup_org_overrides o
  join public.models c on c.slug = o.canonical_slug and c.owning_org_id is null
  join public.model_providers mp
    on mp.model_id = c.id and mp.provider = o.provider
    and mp.provider_model_id = o.provider_model_id
    and mp.owning_org_id is not distinct from o.owning_org_id
    and mp.base_url is not distinct from o.base_url
  where not exists (
    select 1 from public.model_waterfalls pre
    where pre.model_id = c.id and pre.org_id = o.org_id
  )
  order by c.id, o.org_id, mp.id, o.position
)
insert into public.model_waterfalls (model_id, org_id, position, model_provider_id)
select model_id, org_id,
       row_number() over (partition by model_id, org_id order by src_position, route_id) - 1,
       route_id
from resolved
on conflict (model_id, org_id, position) do nothing;

drop table dedup_org_overrides;
drop table catalog_dedup_map;

-- 9. Clean display names for every canonical this sweep touched: maker-brand
--    casing ("Claude Opus 4.5", "GPT-5.2 Codex", "o3 Mini"), never a
--    lane-decorated or date-stamped artifact.
update public.models m
set display_name = v.display_name
from (values
  ('aoai-sora', 'AOAI Sora'),
  ('claude-haiku-4.5', 'Claude Haiku 4.5'),
  ('claude-opus-4.1', 'Claude Opus 4.1'),
  ('claude-opus-4.5', 'Claude Opus 4.5'),
  ('claude-opus-4.6', 'Claude Opus 4.6'),
  ('claude-opus-4.7', 'Claude Opus 4.7'),
  ('claude-opus-4.8', 'Claude Opus 4.8'),
  ('claude-opus-5', 'Claude Opus 5'),
  ('claude-sonnet-4.5', 'Claude Sonnet 4.5'),
  ('claude-sonnet-4.6', 'Claude Sonnet 4.6'),
  ('claude-sonnet-5', 'Claude Sonnet 5'),
  ('codex-mini', 'Codex Mini'),
  ('computer-use-preview', 'Computer Use Preview'),
  ('deepseek-v3.1', 'DeepSeek V3.1'),
  ('deepseek-v3.2', 'DeepSeek V3.2'),
  ('deepseek-v4-flash', 'DeepSeek V4 Flash'),
  ('deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731'),
  ('deepseek-v4-pro', 'DeepSeek V4 Pro'),
  ('embed-english-v3', 'Embed English V3'),
  ('embed-multilingual-v3', 'Embed Multilingual V3'),
  ('flux-1-schnell', 'Flux 1 Schnell'),
  ('gemma-4-31b-it', 'Gemma 4 31b It'),
  ('glm-4.7', 'GLM 4.7'),
  ('glm-4.7-flash', 'GLM 4.7 Flash'),
  ('glm-5.1', 'GLM 5.1'),
  ('glm-5.2', 'GLM 5.2'),
  ('glm-5.2-fast', 'GLM 5.2 Fast'),
  ('gpt-4-turbo', 'GPT-4 Turbo'),
  ('gpt-4.1', 'GPT-4.1'),
  ('gpt-4.1-mini', 'GPT-4.1 Mini'),
  ('gpt-4.1-nano', 'GPT-4.1 Nano'),
  ('gpt-4.5-preview', 'GPT-4.5 Preview'),
  ('gpt-4o', 'GPT-4o'),
  ('gpt-4o-audio-preview', 'GPT-4o Audio Preview'),
  ('gpt-4o-canvas', 'GPT-4o Canvas'),
  ('gpt-4o-mini', 'GPT-4o Mini'),
  ('gpt-4o-mini-audio-preview', 'GPT-4o Mini Audio Preview'),
  ('gpt-4o-mini-realtime-preview', 'GPT-4o Mini Realtime Preview'),
  ('gpt-4o-mini-transcribe', 'GPT-4o Mini Transcribe'),
  ('gpt-4o-mini-tts', 'GPT-4o Mini Tts'),
  ('gpt-4o-realtime-preview', 'GPT-4o Realtime Preview'),
  ('gpt-4o-transcribe', 'GPT-4o Transcribe'),
  ('gpt-4o-transcribe-diarize', 'GPT-4o Transcribe Diarize'),
  ('gpt-5', 'GPT-5'),
  ('gpt-5-chat', 'GPT-5 Chat'),
  ('gpt-5-codex', 'GPT-5 Codex'),
  ('gpt-5-mini', 'GPT-5 Mini'),
  ('gpt-5-mini-lite', 'GPT-5 Mini Lite'),
  ('gpt-5-nano', 'GPT-5 Nano'),
  ('gpt-5-pro', 'GPT-5 Pro'),
  ('gpt-5.1', 'GPT-5.1'),
  ('gpt-5.1-chat', 'GPT-5.1 Chat'),
  ('gpt-5.1-codex', 'GPT-5.1 Codex'),
  ('gpt-5.1-codex-max', 'GPT-5.1 Codex Max'),
  ('gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini'),
  ('gpt-5.2', 'GPT-5.2'),
  ('gpt-5.2-chat', 'GPT-5.2 Chat'),
  ('gpt-5.2-codex', 'GPT-5.2 Codex'),
  ('gpt-5.3-chat', 'GPT-5.3 Chat'),
  ('gpt-5.3-codex', 'GPT-5.3 Codex'),
  ('gpt-5.4', 'GPT-5.4'),
  ('gpt-5.4-mini', 'GPT-5.4 Mini'),
  ('gpt-5.4-nano', 'GPT-5.4 Nano'),
  ('gpt-5.4-pro', 'GPT-5.4 Pro'),
  ('gpt-5.5', 'GPT-5.5'),
  ('gpt-5.6-luna', 'GPT-5.6 Luna'),
  ('gpt-5.6-sol', 'GPT-5.6 Sol'),
  ('gpt-5.6-terra', 'GPT-5.6 Terra'),
  ('gpt-audio', 'GPT Audio'),
  ('gpt-audio-1.5', 'GPT Audio 1.5'),
  ('gpt-audio-mini', 'GPT Audio Mini'),
  ('gpt-chat-latest', 'GPT Chat Latest'),
  ('gpt-image-1', 'GPT Image 1'),
  ('gpt-image-1-mini', 'GPT Image 1 Mini'),
  ('gpt-image-1.5', 'GPT Image 1.5'),
  ('gpt-image-2', 'GPT Image 2'),
  ('gpt-live-transcribe', 'GPT Live Transcribe'),
  ('gpt-offline-whisper-1', 'GPT Offline Whisper 1'),
  ('gpt-oss-120b', 'GPT Oss 120b'),
  ('gpt-oss-20b', 'GPT Oss 20b'),
  ('gpt-realtime', 'GPT Realtime'),
  ('gpt-realtime-1.5', 'GPT Realtime 1.5'),
  ('gpt-realtime-2', 'GPT Realtime 2'),
  ('gpt-realtime-2.1', 'GPT Realtime 2.1'),
  ('gpt-realtime-2.1-mini', 'GPT Realtime 2.1 Mini'),
  ('gpt-realtime-mini', 'GPT Realtime Mini'),
  ('gpt-realtime-translate', 'GPT Realtime Translate'),
  ('gpt-realtime-whisper', 'GPT Realtime Whisper'),
  ('gpt-realtime-whisper-2', 'GPT Realtime Whisper 2'),
  ('gpt-transcribe', 'GPT Transcribe'),
  ('grok-4.20-multi-agent', 'Grok 4.20 Multi Agent'),
  ('grok-4.6', 'Grok 4.6'),
  ('kimi-k2.5', 'Kimi K2.5'),
  ('kimi-k2.6', 'Kimi K2.6'),
  ('kimi-k2.7-code', 'Kimi K2.7 Code'),
  ('llama-v3.1-8b-instruct', 'Llama V3.1 8b Instruct'),
  ('mai-image-2', 'MAI Image 2'),
  ('mai-image-2.5', 'MAI Image 2.5'),
  ('mai-image-2.5-flash', 'MAI Image 2.5 Flash'),
  ('mai-image-2.5-pro', 'MAI Image 2.5 Pro'),
  ('mai-image-2e', 'MAI Image 2e'),
  ('mai-m365', 'MAI M365'),
  ('mai-thinking-1', 'MAI Thinking 1'),
  ('minimax-m2.1', 'MiniMax M2.1'),
  ('minimax-m2.5', 'MiniMax M2.5'),
  ('ministral-14b-2512', 'Ministral 14b 2512'),
  ('mistral-large-3', 'Mistral Large 3'),
  ('model-router', 'Model Router'),
  ('nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30b A3b'),
  ('nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120b A12b'),
  ('nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra 550b A55b'),
  ('nemotron-3.5-lightning', 'Nemotron 3.5 Lightning'),
  ('nemotron-nano-12b-v2', 'Nemotron Nano 12b V2'),
  ('nemotron-nano-9b-v2', 'Nemotron Nano 9b V2'),
  ('nova-2-lite-v1', 'Nova 2 Lite V1'),
  ('o1', 'o1'),
  ('o1-mini', 'o1 Mini'),
  ('o1-preview', 'o1 Preview'),
  ('o1-pro', 'o1 Pro'),
  ('o3', 'o3'),
  ('o3-deep-research', 'o3 Deep Research'),
  ('o3-mini', 'o3 Mini'),
  ('o3-mini-alpha', 'o3 Mini Alpha'),
  ('o3-pro', 'o3 Pro'),
  ('o4-mini', 'o4 Mini'),
  ('paddleocr-vl-1.6', 'PaddleOCR Vl 1.6'),
  ('qwen3.5-122b-a10b', 'Qwen3.5 122b A10b'),
  ('qwen3.5-27b', 'Qwen3.5 27b'),
  ('qwen3.5-35b-a3b', 'Qwen3.5 35b A3b'),
  ('qwen3.5-397b-a17b', 'Qwen3.5 397b A17b'),
  ('qwen3.5-4b', 'Qwen3.5 4b'),
  ('qwen3.5-9b', 'Qwen3.5 9b'),
  ('qwen3.6-27b', 'Qwen3.6 27b'),
  ('qwen3.6-35b-a3b', 'Qwen3.6 35b A3b'),
  ('qwen3.7-max', 'Qwen3.7 Max'),
  ('qwen3.7-plus', 'Qwen3.7 Plus'),
  ('qwen3.8-2.4t-a95b', 'Qwen3.8 2.4t A95b'),
  ('qwen3.8-27b', 'Qwen3.8 27b'),
  ('qwen3.8-max', 'Qwen3.8 Max'),
  ('sora', 'Sora'),
  ('sora-2', 'Sora 2')
) as v(slug, display_name)
where m.slug = v.slug and m.owning_org_id is null
  and m.display_name is distinct from v.display_name
  -- Only replace a JUNK display (lane-suffixed, date-stamped, or a raw slug
  -- artifact); a curated human name ("DeepSeek V4 Flash") is never clobbered.
  and (
    m.display_name ~ '\((Azure Foundry|Bedrock|Fireworks|Azure)\)'
    or m.display_name ~ '20\d{6}'
    or m.display_name ~ '20\d{2}-\d{2}-\d{2}'
    or m.display_name = m.slug
    or m.display_name ~ '^(azure_openai|bedrock|fireworks)-'
    or m.display_name ~ '^[a-z0-9._-]+$'
  );

-- 10. Catalog-wide sweep: provider provenance never lives in a model's display
--     name (it belongs on the provider lane). Idempotent suffix strip.
update public.models m
set display_name = trim(regexp_replace(
      display_name, '\s*\((Azure Foundry|Bedrock|Fireworks|Azure)\)$', ''))
where m.owning_org_id is null
  and m.display_name ~ '\((Azure Foundry|Bedrock|Fireworks|Azure)\)$';
