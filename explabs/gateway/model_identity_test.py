# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Canonicalization matrix: which serving lanes merge, which stay separate.

The table is the contract. Each row is a real-shaped (provider, wire id) and the
canonical slug it must reduce to; rows that share a slug MERGE onto one catalog
model, rows with distinct slugs STAY separate. The conservatism cases (different
sizes/versions, differently-spelled versions across lanes) are asserted
explicitly because a false merge mischarges a caller.
"""

from __future__ import annotations

import pytest

from explabs.gateway.model_identity import canonicalize

# Each entry is a label, a provider, a wire id, and the canonical slug expected.
_MATRIX: tuple[tuple[str, str, str, str], ...] = (
    # --- The Inkling case: three lanes, two identities -------------------
    # OpenRouter (curated seed), Azure Foundry (fw-inkling), and Bedrock all
    # name Thinking Machines' Inkling; they collapse onto one `inkling` model.
    ("openrouter inkling (seed)", "openrouter", "thinkingmachines/inkling", "inkling"),
    ("azure fw-inkling", "azure_openai", "fw-inkling", "inkling"),
    ("bedrock inkling", "bedrock", "thinkingmachines.inkling-v1:0", "inkling"),
    # Inkling Small is a DIFFERENT size — it must NOT merge with Inkling.
    (
        "fireworks inkling-small",
        "fireworks",
        "accounts/fireworks/models/inkling-small",
        "inkling-small",
    ),
    ("azure fw-inkling-small", "azure_openai", "fw-inkling-small", "inkling-small"),
    # --- Claude across the curated seed + Bedrock ------------------------
    ("openrouter claude-opus-5", "openrouter", "anthropic/claude-opus-5", "claude-opus-5"),
    ("bedrock claude-opus-5", "bedrock", "anthropic.claude-opus-5-v1:0", "claude-opus-5"),
    (
        "bedrock claude-opus-5 cross-region",
        "bedrock",
        "us.anthropic.claude-opus-5-v1:0",
        "claude-opus-5",
    ),
    # A different Claude size/line stays its own model.
    ("bedrock claude-haiku-5", "bedrock", "anthropic.claude-haiku-5-v1:0", "claude-haiku-5"),
    # --- Bedrock version handling ---------------------------------------
    # The colon suffix is a Bedrock artifact and is stripped; a bare -vN that is
    # part of the real name (deepseek-v3) is preserved so v3 != v2.
    (
        "bedrock titan express v1:0",
        "bedrock",
        "amazon.titan-text-express-v1:0",
        "titan-text-express",
    ),
    ("fireworks deepseek-v3", "fireworks", "accounts/fireworks/models/deepseek-v3", "deepseek-v3"),
    ("fireworks deepseek-v2", "fireworks", "accounts/fireworks/models/deepseek-v2", "deepseek-v2"),
    # --- Differently-spelled versions do NOT merge (conservative) --------
    (
        "fireworks llama v3p1 70b",
        "fireworks",
        "accounts/fireworks/models/llama-v3p1-70b-instruct",
        "llama-v3p1-70b-instruct",
    ),
    ("bedrock llama3-1 70b", "bedrock", "meta.llama3-1-70b-instruct-v1:0", "llama3-1-70b-instruct"),
    # --- Plain hosted ids ------------------------------------------------
    ("azure gpt-4o", "azure_openai", "gpt-4o", "gpt-4o"),
    ("azure gpt-4o-mini", "azure_openai", "gpt-4o-mini", "gpt-4o-mini"),
    # A version dot that is NOT a maker boundary is PRESERVED (the curated launch
    # catalog spells versions with dots), so a discovered dotted lane merges onto
    # the curated dotted slug instead of minting a dash-spelled duplicate.
    ("azure gpt-3.5-turbo", "azure_openai", "gpt-3.5-turbo", "gpt-3.5-turbo"),
    # --- Dotted-version reconciliation across the whole catalog ----------
    # The curated slugs (glm-5.3, kimi-k2.6, gemini-3.7-flash, claude-haiku-4.5,
    # qwen3.8-27b) carry dots; every provider lane that spells the version with a
    # dot must canonicalize to that exact dotted slug, so one real model is one
    # catalog row across OpenRouter, Azure, and Bedrock.
    ("openrouter glm-5.3", "openrouter", "z-ai/glm-5.3", "glm-5.3"),
    ("openrouter kimi-k2.6", "openrouter", "moonshotai/kimi-k2.6", "kimi-k2.6"),
    ("azure kimi-k2.6", "azure_openai", "Kimi-K2.6", "kimi-k2.6"),
    ("bedrock kimi-k2.5", "bedrock", "moonshotai.kimi-k2.5", "kimi-k2.5"),
    ("openrouter gemini-3.7-flash", "openrouter", "google/gemini-3.7-flash", "gemini-3.7-flash"),
    ("openrouter claude-haiku-4.5", "openrouter", "anthropic/claude-haiku-4.5", "claude-haiku-4.5"),
    ("openrouter qwen3.8-27b", "openrouter", "qwen/qwen3.8-27b", "qwen3.8-27b"),
)


@pytest.mark.parametrize(
    ("label", "provider", "wire_id", "expected"), _MATRIX, ids=[m[0] for m in _MATRIX]
)
def test_canonical_slug_matrix(label: str, provider: str, wire_id: str, expected: str) -> None:
    """Each lane reduces to its documented canonical slug."""
    assert canonicalize(provider, wire_id, label).slug == expected


def test_same_model_across_lanes_merges() -> None:
    """OpenRouter, Azure, and Bedrock Inkling share one slug (they merge)."""
    slugs = {
        canonicalize("openrouter", "thinkingmachines/inkling", "Inkling").slug,
        canonicalize("azure_openai", "fw-inkling", "Fw Inkling (Azure Foundry)").slug,
        canonicalize("bedrock", "thinkingmachines.inkling-v1:0", "Inkling (Bedrock)").slug,
    }
    assert slugs == {"inkling"}


def test_different_sizes_stay_separate() -> None:
    """Inkling and Inkling Small are different models and never collapse."""
    inkling = canonicalize("azure_openai", "fw-inkling", "Fw Inkling").slug
    small = canonicalize(
        "fireworks", "accounts/fireworks/models/inkling-small", "Inkling Small"
    ).slug
    assert inkling != small


def test_display_name_is_provider_agnostic() -> None:
    """The canonical display name carries no serving-lane suffix."""
    assert (
        canonicalize("azure_openai", "fw-inkling", "Fw Inkling (Azure Foundry)").display_name
        == "Inkling"
    )
    assert (
        canonicalize(
            "bedrock", "anthropic.claude-opus-5-v1:0", "Claude Opus 5 (Bedrock)"
        ).display_name
        == "Claude Opus 5"
    )


def test_parameter_token_upper_cases_in_display() -> None:
    """A size token reads as a spec (70B), not a word (70b)."""
    assert (
        canonicalize("bedrock", "meta.llama3-1-70b-instruct-v1:0", "x").display_name
        == "Llama3 1 70B Instruct"
    )


def test_number_first_name_stays_letter_first() -> None:
    """A number-first model name is anchored by its maker to stay a valid slug."""
    result = canonicalize("bedrock", "mistral.8x7b-instruct-v0:1", "x")
    assert result.slug[0].isalpha()
    assert result.slug == "mistral-8x7b-instruct"


def test_dotted_versions_reconcile_across_lanes() -> None:
    """A dotted-version model collapses to ONE slug across every provider lane.

    Regression guard for the catalog-wide reconciliation bug: OpenRouter,
    Azure, and Bedrock all spell Kimi K2.6 with a dot, and the curated slug is
    ``kimi-k2.6``. Folding dots to dashes minted a ``kimi-k2-6`` duplicate; the
    dot is now preserved so all lanes share the curated dotted row.
    """
    slugs = {
        canonicalize("openrouter", "moonshotai/kimi-k2.6", "Kimi K2.6").slug,
        canonicalize("azure_openai", "Kimi-K2.6", "Kimi K2.6 (Azure)").slug,
    }
    assert slugs == {"kimi-k2.6"}


def test_unknown_vendor_prefix_is_preserved_not_guessed() -> None:
    """An unrecognized ``vendor/name`` keeps the model tail without a merge key."""
    # The vendor is not a known maker, so it is not used to anchor a slug, but
    # the model tail is still the identity.
    assert canonicalize("fireworks", "somestartup/newmodel-7b", "x").slug == "newmodel-7b"
