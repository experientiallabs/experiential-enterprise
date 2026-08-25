# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Curated cross-provider identity aliases: the judgment layer canonicalize can't do.

:func:`explabs.gateway.model_identity.canonicalize` is a deterministic normalizer:
it merges lanes that spell the SAME identity (after stripping serving-lane
decorations and preserving dotted versions). It deliberately does NOT guess that
two DIFFERENTLY spelled wire ids are the same base model — an automatic guess
that ``grok-4-20-reasoning`` (Azure) is ``grok-4.20-multi-agent`` would risk a
false merge and mischarge a caller.

This module is that missing judgment layer, as DATA: a hand-verified map from a
specific ``(provider, provider_model_id)`` to the canonical catalog slug it must
collapse onto. It is consulted by the catalog sync BEFORE canonicalize, so a
discovered lane whose vendor spelling diverges from the curated slug merges onto
the one canonical model instead of minting a duplicate. Entries are added only
after a human confirms it is the SAME underlying base model; a genuinely
different model (different parameter size, different major version, a distinct
fine-tune, a dated snapshot that is NOT the base) is left OUT so canonicalize
keeps it separate.

The seed's section-9a routing map is the source of the initial entries: those
wire ids were verified live by provision-house-lane as the real primary lane for
each curated model, so they are known-good equivalences. As the full
multi-provider discovery catalog (~900 models across Bedrock/Azure/Fireworks/
OpenRouter) is reviewed maker-by-maker, confirmed same-base-model equivalences
are added here; unsure cases are left separate and tracked for review rather
than guessed.
"""

from __future__ import annotations

import re

from explabs.gateway.model_identity import canonicalize

# (provider, provider_model_id) -> canonical public slug it merges onto.
# Every entry is a divergent VENDOR SPELLING of a model already in the curated
# catalog — the wire id and the curated slug are the same base model but
# canonicalize cannot reduce one to the other without guessing. Verified from the
# seed's section-9a house-lane routing map (provision-house-lane, live-verified).
CANONICAL_ALIASES: dict[tuple[str, str], str] = {
    # Native first-party wires spell the version with a dash; the curated slug
    # uses a dot. Same model, confirmed.
    ("anthropic", "claude-haiku-4-5"): "claude-haiku-4.5",
    ("anthropic", "claude-opus-4-8"): "claude-opus-4.8",
    # Azure Foundry marketing names for Fireworks-origin NVIDIA Nemotron models.
    ("azure_openai", "FW-Nemotron-3-Ultra-NVFP4"): "nemotron-3-ultra-550b-a55b",
    ("azure_openai", "FW-Nemotron-Lightning-3.5-30B-A3B"): "nemotron-3.5-lightning",
    # Azure's reasoning-tier name for xAI Grok 4.20 multi-agent.
    ("azure_openai", "grok-4-20-reasoning"): "grok-4.20-multi-agent",
    # Bedrock renames (maker-prefixed, size/quant-spelled differently).
    ("bedrock", "mistral.ministral-3-14b-instruct"): "ministral-14b-2512",
    ("bedrock", "nvidia.nemotron-nano-3-30b"): "nemotron-3-nano-30b-a3b",
    ("bedrock", "nvidia.nemotron-super-3-120b"): "nemotron-3-super-120b-a12b",
    ("bedrock", "us.amazon.nova-2-lite-v1:0"): "nova-2-lite-v1",
    # Fireworks "pN" version spelling + control-plane path.
    ("fireworks", "accounts/fireworks/models/kimi-k2p7-code"): "kimi-k2.7-code",
    ("fireworks", "accounts/fireworks/models/nemotron-3-ultra-nvfp4"): "nemotron-3-ultra-550b-a55b",
    (
        "fireworks",
        "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b",
    ): "nemotron-3.5-lightning",
    ("fireworks", "accounts/fireworks/models/qwen3p7-plus"): "qwen3.7-plus",
    ("fireworks", "accounts/fireworks/models/qwen3p8-2p4t-a95b"): "qwen3.8-2.4t-a95b",
    ("fireworks", "accounts/fireworks/models/qwen3p8-max"): "qwen3.8-max",
    # --- Full-catalog cross-provider dedup (r3, maker-by-maker over the ~926
    # discovered models). Each entry collapses a divergent Azure/Bedrock/Fireworks
    # spelling onto the canonical model it shares a base identity with, verified
    # against the live catalog dump. Fireworks "pN" version spelling, Azure "FW-"
    # marketing names, Bedrock maker-prefixed/reordered names, redundant "nvidia-"
    # prefixes, and quant tags (fp8/nvfp4/bf16) all resolve to one canonical.
    ("azure_openai", "FW-Nemotron-3-Super-120B-A12B-BF16"): "nemotron-3-super-120b-a12b",
    ("azure_openai", "claude-haiku-4-5"): "claude-haiku-4.5",
    ("azure_openai", "claude-opus-4-8"): "claude-opus-4.8",
    ("bedrock", "cohere.embed-english-v3:0:512"): "embed-english-v3",
    ("bedrock", "cohere.embed-multilingual-v3:0:512"): "embed-multilingual-v3",
    ("bedrock", "global.amazon.nova-2-lite-v1:0"): "nova-2-lite-v1",
    ("bedrock", "openai.gpt-oss-120b-1:0"): "gpt-oss-120b",
    ("bedrock", "openai.gpt-oss-20b-1:0"): "gpt-oss-20b",
    ("bedrock", "us.anthropic.claude-opus-4-8"): "claude-opus-4.8",
    ("bedrock", "us.xai.grok-4.6"): "grok-4.6",
    ("fireworks", "accounts/fireworks/models/deepseek-v3p1"): "deepseek-v3.1",
    ("fireworks", "accounts/fireworks/models/deepseek-v3p2"): "deepseek-v3.2",
    ("fireworks", "accounts/fireworks/models/flux-1-schnell-fp8"): "flux-1-schnell",
    ("fireworks", "accounts/fireworks/models/gemma-4-31b-it-nvfp4"): "gemma-4-31b-it",
    ("fireworks", "accounts/fireworks/models/glm-4p7"): "glm-4.7",
    ("fireworks", "accounts/fireworks/models/glm-4p7-flash"): "glm-4.7-flash",
    ("fireworks", "accounts/fireworks/models/glm-5p1"): "glm-5.1",
    ("fireworks", "accounts/fireworks/models/glm-5p2"): "glm-5.2",
    ("fireworks", "accounts/fireworks/models/glm-5p2-fp8"): "glm-5.2",
    ("fireworks", "accounts/fireworks/models/kimi-k2p5"): "kimi-k2.5",
    ("fireworks", "accounts/fireworks/models/kimi-k2p6"): "kimi-k2.6",
    ("fireworks", "accounts/fireworks/models/llama-v3p1-8b-instruct"): "llama-v3.1-8b-instruct",
    ("fireworks", "accounts/fireworks/models/minimax-m2p1"): "minimax-m2.1",
    ("fireworks", "accounts/fireworks/models/minimax-m2p5"): "minimax-m2.5",
    ("fireworks", "accounts/fireworks/models/mistral-large-3-fp8"): "mistral-large-3",
    (
        "fireworks",
        "accounts/fireworks/models/nemotron-3-super-120b-a12b-bf16",
    ): "nemotron-3-super-120b-a12b",
    ("fireworks", "accounts/fireworks/models/nemotron-3-ultra-bf16"): "nemotron-3-ultra-550b-a55b",
    (
        "fireworks",
        "accounts/fireworks/models/nvidia-nemotron-3-super-120b-a12b-fp8",
    ): "nemotron-3-super-120b-a12b",
    (
        "fireworks",
        "accounts/fireworks/models/nvidia-nemotron-3-super-120b-a12b-nvfp4",
    ): "nemotron-3-super-120b-a12b",
    ("fireworks", "accounts/fireworks/models/nvidia-nemotron-nano-12b-v2"): "nemotron-nano-12b-v2",
    ("fireworks", "accounts/fireworks/models/nvidia-nemotron-nano-9b-v2"): "nemotron-nano-9b-v2",
    ("fireworks", "accounts/fireworks/models/qwen3p5-122b-a10b"): "qwen3.5-122b-a10b",
    ("fireworks", "accounts/fireworks/models/qwen3p5-27b"): "qwen3.5-27b",
    ("fireworks", "accounts/fireworks/models/qwen3p5-35b-a3b"): "qwen3.5-35b-a3b",
    ("fireworks", "accounts/fireworks/models/qwen3p5-397b-a17b"): "qwen3.5-397b-a17b",
    ("fireworks", "accounts/fireworks/models/qwen3p5-4b"): "qwen3.5-4b",
    ("fireworks", "accounts/fireworks/models/qwen3p5-9b"): "qwen3.5-9b",
    ("fireworks", "accounts/fireworks/models/qwen3p6-27b"): "qwen3.6-27b",
    ("fireworks", "accounts/fireworks/models/qwen3p6-35b-a3b"): "qwen3.6-35b-a3b",
    ("fireworks", "accounts/fireworks/models/qwen3p7-max"): "qwen3.7-max",
    ("fireworks", "accounts/fireworks/models/qwen3p8-27b"): "qwen3.8-27b",
    ("fireworks", "accounts/fireworks/routers/glm-5p2-fast"): "glm-5.2-fast",
    # Token-order / dot-vs-dash divergences the fingerprint pass missed: Fireworks
    # spells the version with a dash (paddleocr-vl-1-6) or reorders size tokens
    # (nemotron-nano-3 vs the canonical 3-nano), so canonicalize can't reduce them.
    ("fireworks", "accounts/fireworks/models/paddleocr-vl-1-6"): "paddleocr-vl-1.6",
    ("fireworks", "accounts/fireworks/models/nemotron-nano-3-30b-a3b"): "nemotron-3-nano-30b-a3b",
    # --- Anthropic grind (r3) -------------------------------------------------
    # Azure Foundry registration artifacts: a trailing "-2" on an otherwise
    # canonical Claude id. Verified against Anthropic's live /v1/models and the
    # OpenRouter listing: no x.2 Claude version exists anywhere (only :batch and
    # -fast variants), so these are re-registrations of the base model. Never
    # dot-guessed by the Anthropic rule below — merged only by these entries.
    ("azure_openai", "claude-haiku-4-5-2"): "claude-haiku-4.5",
    ("azure_openai", "claude-opus-4-8-2"): "claude-opus-4.8",
    ("azure_openai", "claude-opus-5-2"): "claude-opus-5",
    ("azure_openai", "claude-sonnet-5-2"): "claude-sonnet-5",
    # --- daily catalog sync 2026-08-23 ---
    ("anthropic", "claude-haiku-4-5-20251001"): "claude-haiku-4.5",
    ("anthropic", "claude-opus-4-5-20251101"): "claude-opus-4.5",
    ("anthropic", "claude-opus-4-6"): "claude-opus-4.6",
    ("anthropic", "claude-opus-4-7"): "claude-opus-4.7",
    ("anthropic", "claude-sonnet-4-5-20250929"): "claude-sonnet-4.5",
    ("anthropic", "claude-sonnet-4-6"): "claude-sonnet-4.6",
    ("gemini", "gemini-3-pro-image-preview"): "gemini-3-pro-image",
    ("gemini", "gemini-3.1-flash-image-preview"): "gemini-3.1-flash-image",
    ("gemini", "gemini-3.1-flash-lite-preview"): "gemini-3.1-flash-lite",
    ("gemini", "nano-banana-pro-preview"): "gemini-3-pro-image",
    ("openai", "chat-latest"): "gpt-chat-latest",
    ("openai", "gpt-4-0613"): "gpt-4",
    ("openai", "gpt-4-turbo-2024-04-09"): "gpt-4-turbo",
    ("openai", "gpt-4.1-2025-04-14"): "gpt-4.1",
    ("openai", "gpt-4.1-mini-2025-04-14"): "gpt-4.1-mini",
    ("openai", "gpt-4.1-nano-2025-04-14"): "gpt-4.1-nano",
    ("openai", "gpt-4o-2024-05-13"): "gpt-4o",
    ("openai", "gpt-4o-2024-08-06"): "gpt-4o",
    ("openai", "gpt-4o-2024-11-20"): "gpt-4o",
    ("openai", "gpt-4o-mini-2024-07-18"): "gpt-4o-mini",
    ("openai", "gpt-4o-mini-transcribe-2025-03-20"): "gpt-4o-mini-transcribe",
    ("openai", "gpt-4o-mini-transcribe-2025-12-15"): "gpt-4o-mini-transcribe",
    ("openai", "gpt-4o-mini-tts-2025-03-20"): "gpt-4o-mini-tts",
    ("openai", "gpt-4o-mini-tts-2025-12-15"): "gpt-4o-mini-tts",
    ("openai", "gpt-4o-search-preview-2025-03-11"): "gpt-4o-search-preview",
    ("openai", "gpt-5-2025-08-07"): "gpt-5",
    ("openai", "gpt-5-chat-latest"): "gpt-5-chat",
    ("openai", "gpt-5-mini-2025-08-07"): "gpt-5-mini",
    ("openai", "gpt-5-nano-2025-08-07"): "gpt-5-nano",
    ("openai", "gpt-5-pro-2025-10-06"): "gpt-5-pro",
    ("openai", "gpt-5-search-api-2025-10-14"): "gpt-5-search-api",
    ("openai", "gpt-5.1-2025-11-13"): "gpt-5.1",
    ("openai", "gpt-5.1-chat-latest"): "gpt-5.1-chat",
    ("openai", "gpt-5.2-2025-12-11"): "gpt-5.2",
    ("openai", "gpt-5.2-chat-latest"): "gpt-5.2-chat",
    ("openai", "gpt-5.3-chat-latest"): "gpt-5.3-chat",
    ("openai", "gpt-5.4-2026-03-05"): "gpt-5.4",
    ("openai", "gpt-5.4-mini-2026-03-17"): "gpt-5.4-mini",
    ("openai", "gpt-5.4-nano-2026-03-17"): "gpt-5.4-nano",
    ("openai", "gpt-5.4-pro-2026-03-05"): "gpt-5.4-pro",
    ("openai", "gpt-5.5-2026-04-23"): "gpt-5.5",
    ("openai", "gpt-5.5-pro-2026-04-23"): "gpt-5.5-pro",
    ("openai", "gpt-audio-2025-08-28"): "gpt-audio",
    ("openai", "gpt-audio-mini-2025-10-06"): "gpt-audio-mini",
    ("openai", "gpt-audio-mini-2025-12-15"): "gpt-audio-mini",
    ("openai", "gpt-image-2-2026-04-21"): "gpt-image-2",
    ("openai", "gpt-realtime-2025-08-28"): "gpt-realtime",
    ("openai", "gpt-realtime-mini-2025-12-15"): "gpt-realtime-mini",
    ("openai", "o1-2024-12-17"): "o1",
    ("openai", "o1-pro-2025-03-19"): "o1-pro",
    ("openai", "o3-2025-04-16"): "o3",
    ("openai", "o3-deep-research-2025-06-26"): "o3-deep-research",
    ("openai", "o3-mini-2025-01-31"): "o3-mini",
    ("openai", "o3-pro-2025-06-10"): "o3-pro",
    ("openai", "o4-mini-2025-04-16"): "o4-mini",
    ("openai", "o4-mini-deep-research-2025-06-26"): "o4-mini-deep-research",
    # Both the dated snapshot and the -latest pointer are the curated
    # `omni-moderation` model; the seed routes both wires onto it.
    ("openai", "omni-moderation-2024-09-26"): "omni-moderation",
    ("openai", "omni-moderation-latest"): "omni-moderation",
    ("openrouter", "amazon/nova-lite-v1"): "bedrock-amazon.nova-lite-v1-0",
    ("openrouter", "amazon/nova-micro-v1"): "bedrock-amazon.nova-micro-v1-0",
    ("openrouter", "amazon/nova-pro-v1"): "bedrock-amazon.nova-pro-v1-0",
    ("openrouter", "deepseek/deepseek-chat"): "deepseek-v3",
    ("openrouter", "deepseek/deepseek-chat-v3-0324"): "deepseek-v3-0324",
    ("openrouter", "deepseek/deepseek-chat-v3.1"): "deepseek-v3.1",
    (
        "openrouter",
        "deepseek/deepseek-r1-distill-llama-70b",
    ): "fireworks-models-deepseek-r1-distill-llama-70b",
    ("openrouter", "deepseek/deepseek-v3.1-terminus"): "fireworks-models-deepseek-v3p1-terminus",
    ("openrouter", "google/gemini-3-pro-image-preview"): "gemini-3-pro-image",
    ("openrouter", "google/gemini-3.1-flash-image-preview"): "gemini-3.1-flash-image",
    ("openrouter", "google/gemini-3.1-flash-lite-preview"): "gemini-3.1-flash-lite",
    ("openrouter", "google/gemma-4-31b-it:free"): "gemma-4-31b-it",
    ("openrouter", "gryphe/mythomax-l2-13b"): "fireworks-models-mythomax-l2-13b",
    ("openrouter", "meta-llama/llama-3.1-8b-instruct"): "llama-v3.1-8b-instruct",
    ("openrouter", "meta-llama/llama-3.2-1b-instruct"): "fireworks-models-llama-v3p2-1b-instruct",
    ("openrouter", "meta-llama/llama-3.2-3b-instruct"): "fireworks-models-llama-v3p2-3b-instruct",
    ("openrouter", "meta/muse-glimmer-30b"): "fireworks-models-muse-glimmer-30b",
    ("openrouter", "minimax/minimax-m2.7"): "fireworks-models-minimax-m2p7",
    ("openrouter", "mistralai/ministral-3b-2512"): "ministral-3-3b-instruct-2512",
    ("openrouter", "mistralai/ministral-8b-2512"): "fireworks-models-ministral-3-8b-instruct-2512",
    (
        "openrouter",
        "mistralai/mistral-small-24b-instruct-2501",
    ): "fireworks-models-mistral-small-24b-instruct-2501",
    ("openrouter", "mistralai/voxtral-small-24b-2507"): "bedrock-mistral.voxtral-small-24b-2507",
    ("openrouter", "moonshotai/kimi-k2"): "fireworks-models-kimi-k2-instruct",
    ("openrouter", "nvidia/nemotron-3-nano-30b-a3b:free"): "nemotron-3-nano-30b-a3b",
    ("openrouter", "nvidia/nemotron-3-super-120b-a12b:free"): "nemotron-3-super-120b-a12b",
    (
        "openrouter",
        "nvidia/nemotron-nano-12b-v2-vl:free",
    ): "fireworks-models-nemotron-nano-v2-12b-vl",
    ("openrouter", "openai/gpt-4o-2024-05-13"): "gpt-4o",
    ("openrouter", "openai/gpt-4o-2024-08-06"): "gpt-4o",
    ("openrouter", "openai/gpt-4o-2024-11-20"): "gpt-4o",
    ("openrouter", "openai/gpt-4o-mini-2024-07-18"): "gpt-4o-mini",
    ("openrouter", "qwen/qwen-2.5-72b-instruct"): "fireworks-models-qwen2p5-72b-instruct",
    ("openrouter", "qwen/qwen-2.5-7b-instruct"): "fireworks-models-qwen2p5-7b-instruct",
    (
        "openrouter",
        "qwen/qwen-2.5-coder-32b-instruct",
    ): "fireworks-models-qwen2p5-coder-32b-instruct",
    ("openrouter", "qwen/qwen3-235b-a22b"): "fireworks-models-qwen3-235b-a22b",
    ("openrouter", "qwen/qwen3-235b-a22b-2507"): "fireworks-models-qwen3-235b-a22b-instruct-2507",
    (
        "openrouter",
        "qwen/qwen3-235b-a22b-thinking-2507",
    ): "fireworks-models-qwen3-235b-a22b-thinking-2507",
    ("openrouter", "qwen/qwen3-30b-a3b"): "fireworks-models-qwen3-30b-a3b",
    (
        "openrouter",
        "qwen/qwen3-30b-a3b-instruct-2507",
    ): "fireworks-models-qwen3-30b-a3b-instruct-2507",
    (
        "openrouter",
        "qwen/qwen3-30b-a3b-thinking-2507",
    ): "fireworks-models-qwen3-30b-a3b-thinking-2507",
    ("openrouter", "qwen/qwen3-8b"): "fireworks-models-qwen3-8b",
    ("openrouter", "qwen/qwen3-coder"): "fireworks-models-qwen3-coder-480b-a35b-instruct",
    (
        "openrouter",
        "qwen/qwen3-coder-30b-a3b-instruct",
    ): "fireworks-models-qwen3-coder-30b-a3b-instruct",
    ("openrouter", "qwen/qwen3-coder-next"): "bedrock-qwen.qwen3-coder-next",
    (
        "openrouter",
        "qwen/qwen3-next-80b-a3b-instruct",
    ): "fireworks-models-qwen3-next-80b-a3b-instruct",
    (
        "openrouter",
        "qwen/qwen3-next-80b-a3b-thinking",
    ): "fireworks-models-qwen3-next-80b-a3b-thinking",
    (
        "openrouter",
        "qwen/qwen3-vl-235b-a22b-instruct",
    ): "fireworks-models-qwen3-vl-235b-a22b-instruct",
    (
        "openrouter",
        "qwen/qwen3-vl-235b-a22b-thinking",
    ): "fireworks-models-qwen3-vl-235b-a22b-thinking",
    ("openrouter", "qwen/qwen3-vl-30b-a3b-instruct"): "fireworks-models-qwen3-vl-30b-a3b-instruct",
    ("openrouter", "qwen/qwen3-vl-30b-a3b-thinking"): "fireworks-models-qwen3-vl-30b-a3b-thinking",
    ("openrouter", "qwen/qwen3-vl-32b-instruct"): "fireworks-models-qwen3-vl-32b-instruct",
    ("openrouter", "qwen/qwen3-vl-8b-instruct"): "fireworks-models-qwen3-vl-8b-instruct",
    ("openrouter", "stepfun/step-3.7-flash"): "fireworks-models-step-3p7-flash-nvfp4",
    ("openrouter", "writer/palmyra-x5"): "bedrock-writer.palmyra-x5-v1-0",
    ("openrouter", "z-ai/glm-4.5"): "fireworks-models-glm-4p5",
    ("openrouter", "z-ai/glm-4.5-air"): "fireworks-models-glm-4p5-air",
    ("openrouter", "z-ai/glm-4.5v"): "fireworks-models-glm-4p5v",
    ("openrouter", "z-ai/glm-4.6"): "fireworks-models-glm-4p6",
}


# --- Maker-specific dated-id rules (r3, the product owner's Anthropic grind) -------------
#
# Some makers stamp their CANONICAL API ids with a release date, so a dated id
# is the SAME model as its base — the opposite of the generic "a dated snapshot
# stays separate" default, which remains the rule for every maker without an
# explicit convention here (DeepSeek's -0731 builds stay their own models).
#
# * ANTHROPIC: ids read claude-<family>-<major>-<minor>[-YYYYMMDD]; Bedrock
#   wraps them as [region.]anthropic.<id>[-vN[:M]]. Anthropic's own /v1/models
#   displays claude-opus-4-5-20251101 as "Claude Opus 4.5" — the dated id IS
#   the base. The dash-spelled minor becomes the dotted canonical (4-5 -> 4.5)
#   ONLY for the known real minor versions below; an unknown pair (e.g. the
#   Azure "-2" registration artifacts) is never dot-guessed — those are
#   explicit entries above, verified against Anthropic's and OpenRouter's live
#   listings (no x.2 Claude exists anywhere).
# * OPENAI: ids read <base>-YYYY-MM-DD (gpt-4o-2024-08-06 style) on the openai
#   and azure_openai lanes (Bedrock spells them openai.<base>-...). The dated
#   id is a snapshot of the base model and merges onto it.

# The real dash-spelled Claude minor versions (family-major.minor). Extend when
# Anthropic ships a new minor; the daily sync's judge proposes entries against
# this rule and a human reviews the PR.
_ANTHROPIC_MINORS = frozenset(
    {
        "haiku-4.5",
        "opus-4.1",
        "opus-4.5",
        "opus-4.6",
        "opus-4.7",
        "opus-4.8",
        "sonnet-4.5",
        "sonnet-4.6",
    }
)

# [region.][anthropic.]claude-...[-YYYYMMDD][-vN[:M]] — group 1 is the undated id.
_ANTHROPIC_WIRE = re.compile(
    r"^(?:(?:us|eu|apac|ap|ca|sa|global)\.)?(?:anthropic\.)?"
    r"(claude-[a-z][a-z0-9-]*?)"
    r"(?:-(20\d{6}))?"
    r"(?:-v\d+(?::\d+)?)?$"
)
_ANTHROPIC_MINOR_SPLIT = re.compile(r"^(claude-[a-z-]+)-(\d+)-(\d+)$")

# OpenAI's dated snapshot suffix on its own/bedrock lanes: <base>-YYYY-MM-DD.
_OPENAI_DATED = re.compile(
    r"^(?:(?:us|eu|apac|ap|ca|sa|global)\.)?(?:openai\.)?"
    r"((?:gpt|chatgpt|o\d|sora|dall-e|codex)[a-z0-9.-]*?)"
    r"-20\d{2}-\d{2}-\d{2}$"
)

# Azure Foundry stamps EVERY catalog registration with a -YYYY-MM-DD suffix —
# its own MAI/model-router entries and third-party models alike
# (Kimi-K2.6-2026-04-20 is Kimi K2.6 stamped with its release date). On the
# azure_openai lane a full-date suffix is registration metadata, never a
# distinct model, so the wire merges onto its stripped base.
_AZURE_DATED = re.compile(r"^(.+?)-20\d{2}-\d{2}-\d{2}$")


def _anthropic_canonical(provider_model_id: str) -> str | None:
    """The canonical slug for an Anthropic-convention wire id, if derivable."""
    match = _ANTHROPIC_WIRE.match(provider_model_id)
    if match is None:
        return None
    base, dated = match.group(1), match.group(2)
    dotted = base
    minor = _ANTHROPIC_MINOR_SPLIT.match(base)
    if minor is not None:
        candidate = f"{minor.group(1).removeprefix('claude-')}-{minor.group(2)}.{minor.group(3)}"
        if candidate in _ANTHROPIC_MINORS:
            dotted = f"{minor.group(1)}-{minor.group(2)}.{minor.group(3)}"
        elif dated is None:
            # An unknown dash pair on an UNDATED id (the Azure "-2" artifacts)
            # is never dot-guessed; only an explicit entry may merge it.
            return None
    # A dated id always merges onto its (dotted) base; an undated id resolves
    # only when the dash->dot mapping applied (else canonicalize handles it).
    if dated is None and dotted == base:
        return None
    return dotted


def resolve_canonical_slug(provider: str, provider_model_id: str) -> str | None:
    """Return the curated canonical slug for a divergent wire id, if one is known.

    Resolution order: the explicit entry map first (hand-verified, always wins),
    then the maker-convention rules (Anthropic dated/dash ids on any lane;
    OpenAI dated snapshots on the openai/azure_openai/bedrock lanes).

    Args:
        provider: The serving-lane provider key.
        provider_model_id: The model's id on that provider's wire.

    Returns:
        The canonical slug this wire id must merge onto, or ``None`` when no
        curated equivalence exists (the caller then falls back to
        :func:`explabs.gateway.model_identity.canonicalize`).
    """
    wire = provider_model_id.strip()
    explicit = CANONICAL_ALIASES.get((provider, wire))
    if explicit is not None:
        return explicit
    lowered = wire.lower()
    if "claude" in lowered:
        resolved = _anthropic_canonical(lowered)
        if resolved is not None:
            return resolved
    if provider in {"openai", "azure_openai", "bedrock"}:
        dated = _OPENAI_DATED.match(lowered)
        if dated is not None:
            return dated.group(1).rstrip("-.")
    if provider == "azure_openai":
        stamped = _AZURE_DATED.match(wire)
        if stamped is not None:
            base_wire = stamped.group(1)
            # The stripped base resolves like any other wire: an explicit entry
            # or maker rule first, else the deterministic canonical slug.
            base = resolve_canonical_slug(provider, base_wire)
            return base or canonicalize(provider, base_wire, base_wire).slug
    return None
