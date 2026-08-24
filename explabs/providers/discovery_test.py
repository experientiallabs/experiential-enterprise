# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Discovery contract helpers: slugs, modalities, and price conversion."""

from __future__ import annotations

import re

import pytest
from pydantic import ValidationError

from explabs.providers.discovery import (
    DiscoveredModel,
    DiscoveredPrice,
    normalize_modalities,
    slugify,
    to_micro_usd_per_million,
)

_SLUG_RE = re.compile(r"^[a-z][a-z0-9._-]{0,127}$")


def test_slugify_namespaces_and_keeps_slug_grammar() -> None:
    """Every slug leads with the provider namespace and matches the column grammar."""
    assert slugify("fireworks", "kimi-k2p6") == "fireworks-kimi-k2p6"
    # Dots are legal in the grammar and kept; a colon is not, so it collapses.
    assert (
        slugify("bedrock", "anthropic.claude-sonnet-4-6:0")
        == "bedrock-anthropic.claude-sonnet-4-6-0"
    )
    for produced in (
        slugify("bedrock", "ZAI.GLM-5"),
        slugify("fireworks", "accounts/fireworks/models/x"),
        slugify("bedrock", "us.amazon.nova-2-lite-v1:0"),
    ):
        assert _SLUG_RE.match(produced), produced


def test_slugify_degrades_to_the_namespace_for_empty_bodies() -> None:
    """A raw id with no grammar-legal characters still yields a valid slug."""
    assert slugify("bedrock", ":::") == "bedrock"
    assert slugify("fireworks", "") == "fireworks"


def test_slugify_caps_length() -> None:
    """An over-long id is truncated inside the 128-char column bound."""
    produced = slugify("bedrock", "a" * 300)
    assert len(produced) <= 128
    assert _SLUG_RE.match(produced)


def test_normalize_modalities_is_text_first_and_drops_unknowns() -> None:
    """Known modalities are kept text-first; unknown labels are dropped."""
    assert normalize_modalities(["TEXT", "IMAGE"]) == ("text", "image")
    assert normalize_modalities(["IMAGE", "EMBEDDING"]) == ("text", "image")
    assert normalize_modalities(None) == ("text",)
    assert normalize_modalities([]) == ("text",)


def test_to_micro_usd_per_million_scales_per_1k_rate() -> None:
    """$0.0008 per 1K tokens is $0.80 per million = 800000 micro-USD."""
    assert to_micro_usd_per_million(0.0008) == 800_000
    assert to_micro_usd_per_million(0.0) == 0


def test_price_rejects_negative_rates() -> None:
    """A price is always a real non-negative figure, never a sentinel."""
    with pytest.raises(ValidationError):
        DiscoveredPrice(
            input_micro_usd_per_million=-1,
            output_micro_usd_per_million=1,
            pricing_source="aws-price-list",
        )


def test_model_defaults_are_text_only_and_price_less() -> None:
    """A minimal record defaults to a routable text model with no price."""
    model = DiscoveredModel(
        slug="bedrock-x",
        display_name="X (Bedrock)",
        provider="bedrock",
        provider_model_id="x",
    )
    assert model.input_modalities == ("text",)
    assert model.price is None
    assert dict(model.capabilities) == {}
    assert model.billing_source == "host_managed"
    assert model.servable is True
