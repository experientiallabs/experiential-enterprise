# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Pricing, naming, and env-resolution contracts for Experiential Cloud."""

from __future__ import annotations

import pytest

from explabs.gateway.experiential_cloud import (
    API_KEY_ENV,
    BASE_URL_ENV,
    DEEPSEEK_SLUG,
    DEEPSEEK_V4_FLASH_PRICE,
    EXPERIENTIAL_CLOUD_PRICES,
    PROVIDER,
    PROVIDER_DESCRIPTION,
    PROVIDER_LABEL,
    QWEN_3_8_27B_PRICE,
    QWEN_SLUG,
    apply_list_discount,
    experiential_cloud_api_key,
    experiential_cloud_base_url,
    per_token_usd_to_micro_per_million,
)


def test_provider_name_is_the_product_name() -> None:
    """The wire enum is snake_case; the customer-facing name is exact."""
    assert PROVIDER == "experiential_cloud"
    assert PROVIDER_LABEL == "Experiential Cloud"
    assert PROVIDER_DESCRIPTION == (
        "Experiential Cloud is a curated collection of models, hosted and optimized "
        "by Experiential Labs."
    )
    assert DEEPSEEK_SLUG == "deepseek-v4-flash"
    assert QWEN_SLUG == "qwen3.8-27b"


def test_openrouter_per_token_prices_convert_exactly() -> None:
    """Live OpenRouter per-token strings retrieved 2026-08-22 convert exactly."""
    assert per_token_usd_to_micro_per_million("0.00000005306") == 53_060
    assert per_token_usd_to_micro_per_million("0.00000010612") == 106_120
    assert per_token_usd_to_micro_per_million("0.000000010612") == 10_612
    assert per_token_usd_to_micro_per_million("0.0000004") == 400_000
    assert per_token_usd_to_micro_per_million("0.000003") == 3_000_000
    assert per_token_usd_to_micro_per_million("0.00000005") == 50_000


def test_list_discount_is_exactly_eighty_percent_when_integral() -> None:
    """Customer list is 80% of the verified market integer rate."""
    assert apply_list_discount(53_060) == 42_448
    assert apply_list_discount(106_120) == 84_896
    assert apply_list_discount(400_000) == 320_000
    assert apply_list_discount(50_000) == 40_000
    assert apply_list_discount(3_000_000) == 2_400_000


def test_non_integral_discount_fails_closed_by_default() -> None:
    """A fractional 4/5 is refused unless flooring is explicitly opted in."""
    with pytest.raises(ValueError, match="not an integer"):
        apply_list_discount(1)


def test_list_discount_floors_fractional_four_fifths_when_opted_in() -> None:
    """10612 * 4/5 = 8489.6; explicit floor keeps the list at least 20% below."""
    assert 10_612 * 4 % 5 != 0
    with pytest.raises(ValueError, match="not an integer"):
        apply_list_discount(10_612)
    assert apply_list_discount(10_612, floor_fractional=True) == 8_489


def test_non_integral_conversions_and_invalid_rates_fail_closed() -> None:
    """Refuse to invent a rounded market price or discount a negative rate."""
    with pytest.raises(ValueError, match="not an exact micro-USD"):
        per_token_usd_to_micro_per_million("0.0000000800001")
    with pytest.raises(ValueError, match="not a valid"):
        apply_list_discount(-1)
    with pytest.raises(ValueError, match="not a valid"):
        apply_list_discount(-1, floor_fractional=True)


def test_seeded_prices_match_the_verified_2026_08_22_benchmarks() -> None:
    """Documented list prices are 20% below the retrieved OpenRouter market."""
    assert DEEPSEEK_V4_FLASH_PRICE.benchmark.provider == "OpenRouter"
    assert DEEPSEEK_V4_FLASH_PRICE.benchmark.model_id == "deepseek/deepseek-v4-flash"
    assert DEEPSEEK_V4_FLASH_PRICE.benchmark.source_url == "https://openrouter.ai/api/v1/models"
    assert DEEPSEEK_V4_FLASH_PRICE.benchmark.retrieved_at == "2026-08-22"
    assert DEEPSEEK_V4_FLASH_PRICE.input_micro_usd_per_million == 42_448
    assert DEEPSEEK_V4_FLASH_PRICE.output_micro_usd_per_million == 84_896
    assert DEEPSEEK_V4_FLASH_PRICE.cached_input_micro_usd_per_million == 8_489
    assert QWEN_3_8_27B_PRICE.benchmark.model_id == "qwen/qwen3.8-27b"
    assert QWEN_3_8_27B_PRICE.input_micro_usd_per_million == 320_000
    assert QWEN_3_8_27B_PRICE.output_micro_usd_per_million == 2_400_000
    assert QWEN_3_8_27B_PRICE.cached_input_micro_usd_per_million == 40_000
    assert {price.slug for price in EXPERIENTIAL_CLOUD_PRICES} == {DEEPSEEK_SLUG, QWEN_SLUG}


def test_origin_resolution_prefers_the_row_then_the_worker_env() -> None:
    """A missing origin stays unroutable; row URL wins over the shared env."""
    assert experiential_cloud_base_url({}, None) is None
    assert experiential_cloud_base_url({BASE_URL_ENV: "  "}, None) is None
    assert (
        experiential_cloud_base_url({BASE_URL_ENV: "http://vllm.internal:8000/v1"}, None)
        == "http://vllm.internal:8000/v1"
    )
    assert (
        experiential_cloud_base_url(
            {BASE_URL_ENV: "http://shared.internal:8000/v1"},
            "http://flash.internal:8000/v1",
        )
        == "http://flash.internal:8000/v1"
    )


def test_upstream_api_key_is_optional_and_never_invented() -> None:
    """Keyless cluster-internal vLLM is allowed; empty env is not a secret."""
    assert experiential_cloud_api_key({}) is None
    assert experiential_cloud_api_key({API_KEY_ENV: "  "}) is None
    assert experiential_cloud_api_key({API_KEY_ENV: "cluster-token"}) == "cluster-token"
