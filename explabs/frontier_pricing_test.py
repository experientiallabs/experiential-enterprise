# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the frontier list-price anchor."""

from __future__ import annotations

import pytest

from explabs.frontier_pricing import frontier_cost_usd


def test_prices_input_and_output_at_list_rates() -> None:
    """One million input and one million output tokens cost $10 + $50."""
    assert frontier_cost_usd(input_tokens=1_000_000, output_tokens=1_000_000) == pytest.approx(60.0)


def test_cached_tokens_bill_at_cache_read_rate() -> None:
    """Cached input re-prices at one tenth of the input rate."""
    assert frontier_cost_usd(
        input_tokens=1_000_000, output_tokens=0, cached_tokens=1_000_000
    ) == pytest.approx(1.0)


def test_cached_tokens_clamp_to_input_and_negatives_to_zero() -> None:
    """Malformed token counts never produce a negative price."""
    assert frontier_cost_usd(
        input_tokens=100, output_tokens=0, cached_tokens=1_000
    ) == pytest.approx(100 * 1.0 / 1_000_000)
    assert frontier_cost_usd(input_tokens=-5, output_tokens=-5) == 0.0
