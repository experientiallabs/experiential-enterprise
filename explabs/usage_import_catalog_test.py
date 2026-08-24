# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for imported-model mapping and attribution pricing."""

from __future__ import annotations

from explabs.platform_launch_models import PLATFORM_LAUNCH_MODEL_CATALOG
from explabs.usage_import_catalog import map_model, price_usage


def _catalog_rate(alias: str) -> tuple[float, float, float]:
    entry = next(item for item in PLATFORM_LAUNCH_MODEL_CATALOG if item.model == alias)
    cached = (
        entry.usd_per_mtok_cached_input
        if entry.usd_per_mtok_cached_input is not None
        else entry.usd_per_mtok_input
    )
    return entry.usd_per_mtok_input, cached, entry.usd_per_mtok_output


def test_map_model_exact_slug() -> None:
    """An exact catalog slug maps to itself with its provider."""
    mapped = map_model("claude-opus-4-8")
    assert mapped.matched is True
    assert mapped.alias == "claude-opus-4-8"
    assert mapped.provider == "anthropic"


def test_map_model_strips_date_suffix() -> None:
    """A dated Claude Code slug resolves to its catalog base."""
    mapped = map_model("claude-opus-4-8-20260101")
    assert mapped.alias == "claude-opus-4-8"


def test_map_model_strips_provider_prefix() -> None:
    """A provider-namespaced id resolves to the bare catalog slug."""
    assert map_model("anthropic/claude-haiku-4-5").alias == "claude-haiku-4-5"


def test_map_model_codex_variant_exact() -> None:
    """A specific Codex variant slug matches exactly."""
    assert map_model("gpt-5.6-sol").alias == "gpt-5.6-sol"


def test_map_model_bare_family_is_unmatched() -> None:
    """A bare family name never guesses a priced variant."""
    mapped = map_model("gpt-5.6")
    assert mapped.matched is False
    assert mapped.alias is None


def test_map_model_unknown_is_unmatched() -> None:
    """A model outside the catalog is recorded as unmatched, not an error."""
    mapped = map_model("o4-mini")
    assert mapped.matched is False
    assert mapped.provider is None


def test_price_usage_matches_catalog_rates() -> None:
    """Cost sums input, cached, and output at the catalog's list rates."""
    input_rate, cached_rate, output_rate = _catalog_rate("claude-opus-4-8")
    priced = price_usage(
        "claude-opus-4-8",
        input_tokens=1_000_000,
        cached_input_tokens=2_000_000,
        output_tokens=500_000,
    )
    expected = round(1_000_000 * input_rate + 2_000_000 * cached_rate + 500_000 * output_rate)
    assert priced.cost_micro_usd == expected
    assert priced.model.alias == "claude-opus-4-8"


def test_price_usage_unmatched_costs_zero() -> None:
    """An unmatched model still records tokens but carries no cost."""
    priced = price_usage("o4-mini", input_tokens=10_000, cached_input_tokens=0, output_tokens=5_000)
    assert priced.cost_micro_usd == 0
    assert priced.model.matched is False


def test_price_usage_cached_rate_cheaper_than_input() -> None:
    """Cached input is billed below fresh input where the catalog says so."""
    priced_fresh = price_usage(
        "claude-opus-4-8", input_tokens=1_000_000, cached_input_tokens=0, output_tokens=0
    )
    priced_cached = price_usage(
        "claude-opus-4-8", input_tokens=0, cached_input_tokens=1_000_000, output_tokens=0
    )
    assert priced_cached.cost_micro_usd < priced_fresh.cost_micro_usd
