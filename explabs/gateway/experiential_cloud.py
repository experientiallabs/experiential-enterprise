# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Experiential Cloud provider name, worker origin, and list prices.

Customer-facing description (do not paraphrase on product surfaces)::

    Experiential Cloud is a curated collection of models, hosted and
    optimized by Experiential Labs.

Customers never receive the upstream origin or its credential; they call the
hosted Platform gateway with a durable ``xpl_`` key. This module is the
single source of truth for the provider name, that product sentence, the
worker environment contract, public model slugs, and the 20% discount off a
verified public market API price.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import ROUND_FLOOR, Decimal

from pydantic import BaseModel, ConfigDict, Field

PROVIDER = "experiential_cloud"
PROVIDER_LABEL = "Experiential Cloud"
PROVIDER_DESCRIPTION = (
    "Experiential Cloud is a curated collection of models, hosted and optimized "
    "by Experiential Labs."
)
BASE_URL_ENV = "EXPLABS_EXPERIENTIAL_CLOUD_BASE_URL"
API_KEY_ENV = "EXPLABS_EXPERIENTIAL_CLOUD_API_KEY"

# Existing public catalog aliases. ``qwen3-8-27b`` is not a separate slug;
# the shipped alias is ``qwen3.8-27b``.
DEEPSEEK_SLUG = "deepseek-v4-flash"
QWEN_SLUG = "qwen3.8-27b"

# Customer list price is 80% of the verified market rate (20% off).
_LIST_PRICE_NUMERATOR = 4
_LIST_PRICE_DENOMINATOR = 5
_MICRO_USD_PER_MILLION_FROM_PER_TOKEN = Decimal(1000000000000)


class MarketBenchmark(BaseModel):
    """One verified public market API price used as the 100% list baseline.

    ``input_market_usd``, ``output_market_usd``, and ``cached_input_market_usd``
    are the OpenRouter per-token USD strings from the retrieval date.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str
    model_id: str
    source_url: str
    retrieved_at: str
    input_market_usd: str
    output_market_usd: str
    cached_input_market_usd: str


class ExperientialCloudModelPrice(BaseModel):
    """Customer list price for one Experiential Cloud model, in micro-USD."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    slug: str
    provider_model_id: str
    benchmark: MarketBenchmark
    input_micro_usd_per_million: int = Field(ge=0)
    cached_input_micro_usd_per_million: int = Field(ge=0)
    output_micro_usd_per_million: int = Field(ge=0)


def per_token_usd_to_micro_per_million(per_token_usd: str) -> int:
    """Convert an OpenRouter per-token USD string to micro-USD per million tokens.

    Args:
        per_token_usd: Exact decimal USD charged per token by the benchmark.

    Returns:
        Integer micro-USD per million tokens.

    Raises:
        ValueError: The conversion is not an exact integer. Fail closed rather
            than invent a rounded customer price.
    """
    micro = Decimal(per_token_usd) * _MICRO_USD_PER_MILLION_FROM_PER_TOKEN
    if micro != micro.to_integral_value():
        raise ValueError(
            f"market per-token price {per_token_usd!r} is not an exact micro-USD "
            "per million tokens; refuse to invent a rounded list price"
        )
    return int(micro)


def apply_list_discount(
    market_micro_usd_per_million: int, *, floor_fractional: bool = False
) -> int:
    """Return 80% of a verified market rate.

    When ``4/5`` is an exact integer micro-USD amount, return it.
    Fractional results fail closed unless ``floor_fractional`` is
    explicitly True, in which case the list floors so it is at least
    20% below market. Negative market rates always fail closed.

    Args:
        market_micro_usd_per_million: Exact integer market rate.
        floor_fractional: Opt in to flooring a non-integral ``4/5``.
            Default False keeps the fail-closed contract.

    Returns:
        The 20%-discounted customer list rate.

    Raises:
        ValueError: The market rate is negative, or ``4/5`` is not an
            integer and flooring was not opted in.
    """
    if market_micro_usd_per_million < 0:
        raise ValueError(
            f"market rate {market_micro_usd_per_million} is not a valid "
            "micro-USD per million tokens; refuse to invent a list price"
        )
    discounted = (
        Decimal(market_micro_usd_per_million) * _LIST_PRICE_NUMERATOR / _LIST_PRICE_DENOMINATOR
    )
    if discounted == discounted.to_integral_value():
        return int(discounted)
    if not floor_fractional:
        raise ValueError(
            f"80% of {market_micro_usd_per_million} micro-USD per million is not "
            "an integer; refuse to invent a rounded list price"
        )
    return int(discounted.to_integral_value(rounding=ROUND_FLOOR))


def _priced_model(
    *,
    slug: str,
    provider_model_id: str,
    benchmark: MarketBenchmark,
    floor_cached_input_fractional: bool = False,
) -> ExperientialCloudModelPrice:
    """Build one fail-closed discounted price from a verified benchmark.

    Prompt and output rates must convert exactly. Cached input may opt
    into flooring a fractional ``4/5`` via ``floor_cached_input_fractional``.
    """
    return ExperientialCloudModelPrice(
        slug=slug,
        provider_model_id=provider_model_id,
        benchmark=benchmark,
        input_micro_usd_per_million=apply_list_discount(
            per_token_usd_to_micro_per_million(benchmark.input_market_usd)
        ),
        cached_input_micro_usd_per_million=apply_list_discount(
            per_token_usd_to_micro_per_million(benchmark.cached_input_market_usd),
            floor_fractional=floor_cached_input_fractional,
        ),
        output_micro_usd_per_million=apply_list_discount(
            per_token_usd_to_micro_per_million(benchmark.output_market_usd)
        ),
    )


# Retrieved 2026-08-22 from GET https://openrouter.ai/api/v1/models.
DEEPSEEK_V4_FLASH_PRICE = _priced_model(
    slug=DEEPSEEK_SLUG,
    provider_model_id=DEEPSEEK_SLUG,
    benchmark=MarketBenchmark(
        provider="OpenRouter",
        model_id="deepseek/deepseek-v4-flash",
        source_url="https://openrouter.ai/api/v1/models",
        retrieved_at="2026-08-22",
        input_market_usd="0.00000005306",
        output_market_usd="0.00000010612",
        cached_input_market_usd="0.000000010612",
    ),
    # 10612 * 4/5 = 8489.6; the only opted-in fractional floor.
    floor_cached_input_fractional=True,
)

QWEN_3_8_27B_PRICE = _priced_model(
    slug=QWEN_SLUG,
    provider_model_id=QWEN_SLUG,
    benchmark=MarketBenchmark(
        provider="OpenRouter",
        model_id="qwen/qwen3.8-27b",
        source_url="https://openrouter.ai/api/v1/models",
        retrieved_at="2026-08-22",
        input_market_usd="0.0000004",
        output_market_usd="0.000003",
        cached_input_market_usd="0.00000005",
    ),
)

EXPERIENTIAL_CLOUD_PRICES: tuple[ExperientialCloudModelPrice, ...] = (
    DEEPSEEK_V4_FLASH_PRICE,
    QWEN_3_8_27B_PRICE,
)


def experiential_cloud_base_url(
    environment: Mapping[str, str], row_base_url: str | None
) -> str | None:
    """Resolve the cluster-private vLLM origin for one deployment.

    Args:
        environment: Worker environment. Only ``BASE_URL_ENV`` is read.
        row_base_url: Optional per-row origin from ``model_providers.base_url``.

    Returns:
        The origin to call, or ``None`` when neither the row nor the worker
        environment names one. Missing origin leaves the row unroutable.
    """
    if row_base_url:
        return row_base_url
    value = environment.get(BASE_URL_ENV, "").strip()
    return value or None


def experiential_cloud_api_key(environment: Mapping[str, str]) -> str | None:
    """Return the worker-only upstream bearer, when configured.

    Args:
        environment: Worker environment. Only ``API_KEY_ENV`` is read.

    Returns:
        The bearer value, or ``None`` when the upstream is keyless. The
        catalog never stores this value.
    """
    value = environment.get(API_KEY_ENV, "").strip()
    return value or None
