# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The curated cross-provider alias map merges divergent vendor spellings.

Each alias is a spelling canonicalize CANNOT reduce on its own; the map is the
judgment layer that says "this wire id is the same base model as this curated
slug". These tests pin that every alias points at a real, distinct curated slug
and that the resolver only fires for known wire ids (no accidental broad match).
"""

from __future__ import annotations

import pytest

from explabs.gateway.model_aliases import CANONICAL_ALIASES, resolve_canonical_slug
from explabs.gateway.model_identity import canonicalize


@pytest.mark.parametrize(("key", "slug"), sorted(CANONICAL_ALIASES.items()))
def test_alias_is_needed_and_divergent(key: tuple[str, str], slug: str) -> None:
    """Every alias diverges from canonicalize (else it would be redundant)."""
    provider, wire = key
    # The alias exists precisely because the deterministic slug differs.
    assert canonicalize(provider, wire, slug).slug != slug
    # The slug it maps onto is a valid letter-first catalog slug.
    assert slug[0].isalpha()


def test_resolver_returns_alias_for_known_wire() -> None:
    """A known divergent wire id resolves to its curated canonical slug."""
    assert resolve_canonical_slug("azure_openai", "grok-4-20-reasoning") == "grok-4.20-multi-agent"
    assert (
        resolve_canonical_slug("fireworks", "accounts/fireworks/models/qwen3p7-plus")
        == "qwen3.7-plus"
    )
    assert resolve_canonical_slug("anthropic", "claude-opus-4-8") == "claude-opus-4.8"


def test_resolver_is_none_for_unknown_wire() -> None:
    """An unmapped wire id falls through to canonicalize (returns None)."""
    assert resolve_canonical_slug("openrouter", "z-ai/glm-5.3") is None
    assert resolve_canonical_slug("bedrock", "anthropic.claude-opus-5-v1:0") is None


def test_no_alias_collapses_a_distinct_snapshot() -> None:
    """A dated snapshot is NOT aliased to its base model (no false merge).

    deepseek-v4-flash-0731 is a distinct pinned build; it must stay its own
    model, so the Fireworks 0731 wire is deliberately absent from the map.
    """
    assert (
        "fireworks",
        "accounts/fireworks/models/deepseek-v4-flash-0731",
    ) not in CANONICAL_ALIASES


def test_anthropic_dated_ids_merge_onto_their_base() -> None:
    """Anthropic stamps canonical ids with a date: the dated id IS the base.

    Verified against Anthropic's live /v1/models, which displays
    claude-opus-4-5-20251101 as "Claude Opus 4.5". The rule holds on every lane
    spelling (native, Azure, Bedrock's region/maker/version wrapping).
    """
    assert resolve_canonical_slug("azure_openai", "claude-haiku-4-5-20251001") == "claude-haiku-4.5"
    assert (
        resolve_canonical_slug("bedrock", "us.anthropic.claude-opus-4-5-20251101-v1:0")
        == "claude-opus-4.5"
    )
    assert resolve_canonical_slug("anthropic", "claude-sonnet-4-5-20250929") == "claude-sonnet-4.5"
    assert resolve_canonical_slug("azure_openai", "claude-opus-4-1-20250805") == "claude-opus-4.1"


def test_anthropic_known_dash_minor_becomes_dotted() -> None:
    """A KNOWN dash-spelled minor (4-7 == 4.7) resolves to the dotted canonical."""
    assert resolve_canonical_slug("azure_openai", "claude-opus-4-7") == "claude-opus-4.7"
    assert (
        resolve_canonical_slug("bedrock", "us.anthropic.claude-sonnet-4-6") == "claude-sonnet-4.6"
    )
    assert resolve_canonical_slug("bedrock", "us.anthropic.claude-opus-4-6-v1") == "claude-opus-4.6"


def test_anthropic_unknown_dash_pair_is_never_dot_guessed() -> None:
    """An unknown pair (no such Claude minor exists) must not mint a fake x.2.

    The Azure "-2" registration artifacts merge ONLY via their explicit
    entries; a novel unknown pair resolves to nothing and stays separate.
    """
    assert resolve_canonical_slug("azure_openai", "claude-opus-5-3") is None
    # The -2 artifacts resolve through their hand-verified explicit entries.
    assert resolve_canonical_slug("azure_openai", "claude-opus-5-2") == "claude-opus-5"
    assert resolve_canonical_slug("azure_openai", "claude-haiku-4-5-2") == "claude-haiku-4.5"


def test_anthropic_undated_bare_ids_fall_through() -> None:
    """Undated ids without a known dash-minor keep canonicalize's outcome."""
    assert resolve_canonical_slug("anthropic", "claude-fable-5") is None
    assert resolve_canonical_slug("openrouter", "anthropic/claude-opus-4.5") is None


def test_openai_dated_snapshots_merge_onto_their_base() -> None:
    """OpenAI's -YYYY-MM-DD ids are snapshots of the base model."""
    assert resolve_canonical_slug("openai", "gpt-4o-2024-08-06") == "gpt-4o"
    assert resolve_canonical_slug("azure_openai", "o3-mini-2025-01-31") == "o3-mini"
    assert resolve_canonical_slug("bedrock", "us.openai.sora-2-2025-12-05") == "sora-2"


def test_generic_dated_snapshots_stay_separate() -> None:
    """The maker rules never leak: DeepSeek's dated builds stay their own models."""
    assert (
        resolve_canonical_slug("fireworks", "accounts/fireworks/models/deepseek-v4-flash-0731")
        is None
    )
    assert resolve_canonical_slug("azure_openai", "mistral-large-2407") is None


def test_azure_foundry_date_stamps_merge_onto_their_base() -> None:
    """Azure Foundry's -YYYY-MM-DD registration stamp never mints a new model.

    Applies to third-party and Microsoft entries alike: Kimi-K2.6-2026-04-20 is
    Kimi K2.6 stamped with its release date. The stripped base resolves through
    the normal chain, so a stamped SNAPSHOT base stays the snapshot model.
    """
    assert resolve_canonical_slug("azure_openai", "Kimi-K2.6-2026-04-20") == "kimi-k2.6"
    assert (
        resolve_canonical_slug("azure_openai", "DeepSeek-V4-Flash-2026-04-23")
        == "deepseek-v4-flash"
    )
    # The dated stamp on a SNAPSHOT build resolves to the snapshot, not its base.
    assert (
        resolve_canonical_slug("azure_openai", "DeepSeek-V4-Flash-0731-2026-07-31")
        == "deepseek-v4-flash-0731"
    )
    assert resolve_canonical_slug("azure_openai", "model-router-2025-11-18") == "model-router"
    # The stamp is azure_openai-lane metadata only; other providers are untouched.
    assert resolve_canonical_slug("fireworks", "kimi-k2.6-2026-04-20") is None
