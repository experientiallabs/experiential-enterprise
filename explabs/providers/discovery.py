# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed contracts for provider model discovery.

Fireworks and Bedrock expose their full served-model lists over live APIs
(unlike the offline-known providers whose metadata is authored into the launch
catalog). :func:`explabs.providers.fireworks.list_models` and
:func:`explabs.providers.bedrock.list_models` return these ``DiscoveredModel``
records, and :mod:`explabs.gateway.catalog_sync` upserts them into
``public.models`` / ``public.model_providers`` as platform-funded
(``host_managed``) catalog rows.

Money boundary (AGENTS.md): platform-funded prices come from an authoritative
source only — the AWS Price List for Bedrock, hand-curated launch-catalog
prices for Fireworks — never invented. A model discovered without an
authoritative price is ingested with ``price=None`` and left hidden and
unserved until a price arrives; a wrong price would mischarge, so the join is
exact-match only.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# The modality vocabulary ``public.models.input_modalities`` accepts
# (models_modalities_check). Anything a provider reports outside this set is
# dropped rather than widening the column's contract.
_KNOWN_MODALITIES = frozenset({"text", "image", "audio", "video", "pdf"})

# ``public.models.slug`` grammar: a lowercase letter, then lowercase letters,
# digits, dot, underscore, or dash, up to 128 chars total.
_SLUG_BODY = re.compile(r"[^a-z0-9._-]+")
_SLUG_MAX = 128


class DiscoveredPrice(BaseModel):
    """One deployment's per-million-token prices in integer micro-USD.

    ``None`` means "no authoritative price" and must never be read as zero
    (mirrors the ``model_providers`` price columns). A ``DiscoveredPrice`` is
    only constructed from a real provider/price-list figure.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    input_micro_usd_per_million: int = Field(ge=0)
    output_micro_usd_per_million: int = Field(ge=0)
    cached_input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    pricing_source: str


class DiscoveredModel(BaseModel):
    """One provider's served model plus the single route that reaches it.

    A model concept can be reached through several providers; discovery emits
    one record per (provider, wire id). :mod:`explabs.gateway.catalog_sync`
    derives the model's CANONICAL catalog slug from ``provider`` +
    ``provider_model_id`` (see :func:`explabs.gateway.model_identity.canonicalize`)
    and attaches this record as one ``model_providers`` deployment under that
    canonical ``public.models`` row, so two lanes serving the same real model
    converge on one catalog entry with a deployment row each. The ``slug`` field
    here is the provider-scoped stable identifier discovery uses to dedupe and
    order its own output; it is not the catalog slug.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    slug: str
    display_name: str
    provider: str
    provider_model_id: str
    region: str | None = None
    context_window: int | None = None
    input_modalities: tuple[str, ...] = ("text",)
    supported_params: Mapping[str, bool] = Field(default_factory=dict)
    capabilities: Mapping[str, bool] = Field(default_factory=dict)
    price: DiscoveredPrice | None = None
    # ``host_managed`` = platform-funded (needs a launch-catalog price, else
    # hidden). ``customer_managed`` = BYOK-by-default (the caller funds it with
    # their own provider key, so it is active without a house price).
    billing_source: Literal["host_managed", "customer_managed"] = "host_managed"
    # Whether the chat gateway can serve this model at all. A 1:1 provider mirror
    # includes non-chat rows (embeddings, image, adapters) for completeness;
    # those are ``servable=False`` — listed in the catalog but never given a
    # served route, so the storefront shows them while ``/v1/models`` omits them.
    servable: bool = True


def slugify(namespace: str, raw: str) -> str:
    """Build a schema-valid, provider-scoped identifier for a discovered model.

    The ``namespace`` (a provider key such as ``fireworks``/``bedrock``) leads
    every value so a provider's discovered records carry a stable, unique
    identifier to dedupe and order by; the catalog slug is derived separately by
    :func:`explabs.gateway.model_identity.canonicalize`. ``raw`` is lowercased
    and every run of characters outside the slug grammar collapses to a dash.

    Args:
        namespace: Provider prefix that scopes this sync's owned slugs.
        raw: The provider wire id (or its meaningful tail) to derive from.

    Returns:
        A slug matching ``^[a-z][a-z0-9._-]{0,127}$``.
    """
    body = _SLUG_BODY.sub("-", raw.lower()).strip("-._")
    slug = f"{namespace}-{body}" if body else namespace
    return slug[:_SLUG_MAX].rstrip("-._")


def normalize_modalities(raw: object) -> tuple[str, ...]:
    """Map provider modality labels onto the column's vocabulary, text-first.

    Unknown labels are dropped and ``text`` is always guaranteed present (the
    column forbids an empty list), so a text model with an exotic extra
    modality still yields a valid, non-empty tuple.
    """
    found = ["text"]
    if isinstance(raw, (list, tuple)):
        for item in raw:
            label = str(item).strip().lower()
            if label in _KNOWN_MODALITIES and label not in found:
                found.append(label)
    return tuple(found)


def to_micro_usd_per_million(usd_per_1k_tokens: float) -> int:
    """Convert an AWS Price List "per 1K tokens" USD rate to micro-USD/million.

    Per-million is the 1K rate times 1000; micro-USD is times 1e6, so the
    factor is 1e9. Rounded to the nearest integer micro-USD, the column's unit.
    """
    return round(usd_per_1k_tokens * 1_000_000_000)
