# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Map imported model strings to the launch catalog and price their usage.

The historical-spend import (`/api/gateway/usage/import`) receives a raw model
string exactly as it appeared in a tenant's local Codex or Claude Code log,
plus that turn's token counts. This module turns the raw string into a catalog
model and an attribution cost, in micro-USD, from the launch catalog list
price.

Matching is deliberately conservative: a raw string maps to a catalog model
only when the catalog model is an exact match or a less-specific prefix of the
raw string (so a dated or versioned slug like ``claude-opus-4-8-20260101`` maps
to ``claude-opus-4-8``). It never guesses a more-specific variant from a
less-specific string, because the variants carry different prices and guessing
would invent money. An unmatched model is recorded with zero cost and a marker,
never dropped and never priced.

Cost is attribution only. It is never charged and never touches the credit
ledger; see ``20260820103000_gateway_usage_import.sql``.
"""

from __future__ import annotations

from dataclasses import dataclass

from explabs.platform_launch_models import (
    PLATFORM_LAUNCH_MODEL_CATALOG,
    PlatformLaunchModelMetadata,
)

# Provider namespaces some tools prepend to the model id (e.g. "anthropic/").
_PROVIDER_PREFIXES: tuple[str, ...] = (
    "anthropic/",
    "openai/",
    "google/",
    "gemini/",
)


@dataclass(frozen=True, slots=True)
class MappedModel:
    """The catalog resolution of one raw model string.

    ``alias`` and ``provider`` are the catalog model's identity when
    ``matched`` is true, and ``None`` when the raw string matched nothing.
    """

    matched: bool
    alias: str | None
    provider: str | None


@dataclass(frozen=True, slots=True)
class PricedUsage:
    """A mapped model plus the attributed micro-USD cost of one usage record."""

    model: MappedModel
    cost_micro_usd: int


def _normalize(raw_model: str) -> str:
    """Lower-case and strip a leading provider namespace from a raw model id."""
    normalized = raw_model.strip().lower()
    for prefix in _PROVIDER_PREFIXES:
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix) :]
            break
    return normalized


def _matches(catalog_slug: str, normalized_raw: str) -> bool:
    """Return whether a catalog slug names the raw model.

    True when the raw string is the slug exactly, or the slug followed by a
    version/date/variant separator (the raw string is the MORE specific one).
    The reverse — a catalog slug more specific than the raw string — is
    intentionally not a match, so a bare family name never resolves to a
    priced variant.
    """
    if normalized_raw == catalog_slug:
        return True
    return any(normalized_raw.startswith(f"{catalog_slug}{sep}") for sep in ("-", ":", "@"))


def map_model(raw_model: str) -> MappedModel:
    """Resolve a raw model string to a launch-catalog model, best effort.

    Args:
        raw_model: The model id exactly as it appeared in the local log.

    Returns:
        The catalog model when one matches, else an unmatched result.
    """
    normalized = _normalize(raw_model)
    best: PlatformLaunchModelMetadata | None = None
    for entry in PLATFORM_LAUNCH_MODEL_CATALOG:
        candidate = entry.model.lower()
        if not _matches(candidate, normalized):
            continue
        # Prefer the longest (most specific) catalog slug that still matches,
        # so a dated slug resolves to its exact base rather than a shorter
        # coincidental prefix.
        if best is None or len(entry.model) > len(best.model):
            best = entry
    if best is None:
        return MappedModel(matched=False, alias=None, provider=None)
    return MappedModel(matched=True, alias=best.model, provider=best.provider)


def _catalog_entry(alias: str) -> PlatformLaunchModelMetadata | None:
    """Return the catalog entry for an exact slug, or None."""
    for entry in PLATFORM_LAUNCH_MODEL_CATALOG:
        if entry.model == alias:
            return entry
    return None


def price_usage(
    raw_model: str,
    *,
    input_tokens: int,
    cached_input_tokens: int,
    output_tokens: int,
) -> PricedUsage:
    """Map a raw model and compute its attribution cost in micro-USD.

    Cost is ``input * input_rate + cached * cached_rate + output * output_rate``
    where each catalog rate is USD per million tokens, which equals micro-USD
    per token. The cached rate falls back to the input rate when the catalog
    declares no cached price. Unmatched models cost zero.

    Args:
        raw_model: The model id from the local log.
        input_tokens: Fresh (non-cached) input tokens.
        cached_input_tokens: Cached input tokens.
        output_tokens: Output tokens (reasoning included).

    Returns:
        The mapped model and its integer micro-USD attribution cost.
    """
    model = map_model(raw_model)
    if model.alias is None:
        return PricedUsage(model=model, cost_micro_usd=0)
    entry = _catalog_entry(model.alias)
    if entry is None:
        return PricedUsage(model=model, cost_micro_usd=0)
    cached_rate = (
        entry.usd_per_mtok_cached_input
        if entry.usd_per_mtok_cached_input is not None
        else entry.usd_per_mtok_input
    )
    cost = (
        input_tokens * entry.usd_per_mtok_input
        + cached_input_tokens * cached_rate
        + output_tokens * entry.usd_per_mtok_output
    )
    return PricedUsage(model=model, cost_micro_usd=round(cost))
