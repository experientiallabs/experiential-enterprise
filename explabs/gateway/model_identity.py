# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Canonical model identity: collapse per-provider rows onto one catalog model.

The provider catalog sync (:mod:`explabs.gateway.catalog_sync`) discovers the
SAME real model through several serving lanes — OpenRouter (the curated launch
catalog), Fireworks, Bedrock, Azure Foundry — each naming it on its own wire.
An earlier sync minted a SEPARATE ``public.models`` row per lane under a
provider-namespaced slug (``fireworks-…`` / ``bedrock-…`` / ``azure_openai-…``),
so one model appeared as three near-duplicate catalog entries, most with missing
data.

This module derives the CANONICAL identity of a discovered model — a single
public slug and a provider-agnostic display name keyed on the model's true
identity (maker + model + size/version) — so the sync can attach every serving
lane as a ``model_providers`` deployment row under ONE ``public.models`` row.
That is the "show all the providers a model can be called from, each with its own
price" behavior.

Conservatism is the whole design (money and routing ride on it): two lanes merge
ONLY when their identifiers reduce to the SAME canonical slug after a small,
explicit set of decorations is stripped. A false merge (charging a caller one
model's price for another) is far worse than a false split (two rows for one
model), so the normalization strips only what is unambiguously a serving-lane
decoration and never rewrites a version or size token:

- **Path/vendor prefixes.** ``accounts/fireworks/models/`` (Fireworks control
  plane) and a leading ``vendor/`` segment (``thinkingmachines/inkling`` →
  ``inkling``) are stripped; the tail is the model name.
- **Bedrock maker + version.** ``anthropic.claude-opus-5-v1:0`` splits on the
  maker token (``anthropic``), drops an optional region prefix (``us.`` …), and
  strips ONLY the Bedrock colon-version suffix (``-v1:0`` / ``:0``) — never a
  bare ``-v3`` that is part of a real name like ``deepseek-v3``.
- **Azure Foundry lane marker.** Foundry lists Fireworks-origin models as
  ``fw-<name>``; the ``fw-`` marker is stripped for that provider only, so
  ``fw-inkling`` → ``inkling`` merges with the curated ``inkling`` row.

Everything else is preserved, so ``inkling`` and ``inkling-small`` (different
sizes) stay distinct, as do ``llama-3.1-8b`` and ``llama-3.1-70b``. Two lanes
that spell a version differently on the wire (Fireworks ``llama-v3p1`` vs
Bedrock ``llama3-1``) simply do not merge — the safe outcome.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ``public.models.slug`` grammar (models_namespace_slug_key): a lowercase
# letter, then lowercase letters, digits, dot, underscore, or dash, <= 128.
# Dots are PRESERVED (not folded to dashes): the curated launch catalog spells
# version numbers with dots (``glm-5.3``, ``kimi-k2.6``, ``qwen3.8-27b``,
# ``claude-haiku-4.5``), so folding ``z-ai/glm-5.3`` to ``glm-5-3`` would mint a
# dash-spelled DUPLICATE model instead of merging the discovered lane onto the
# curated dotted row. Keeping the dot makes one real model reconcile to one
# catalog row across every provider that spells its version with a dot.
_SLUG_MAX = 128
_SLUG_NONWORD = re.compile(r"[^a-z0-9.]+")
# Collapse any run of dots/dashes left by normalization to a single dash-or-dot
# and never lead/trail with a separator.
_SLUG_DOT_RUN = re.compile(r"\.{2,}")

# Fireworks control-plane names carry this account path; strip it to the model.
_FIREWORKS_PATHS = ("accounts/fireworks/models/", "accounts/fireworks/")

# Bedrock model ids read ``[<region>.]<maker>.<name>[-v<major>:<minor>]``; a
# cross-region inference profile prepends a region token. Only these leading
# tokens are treated as regions to drop, so a maker or model token is never
# mistaken for one.
_BEDROCK_REGIONS = frozenset({"us", "eu", "apac", "ap", "ca", "sa", "us-gov", "global"})

# The maker tokens Bedrock (and OpenRouter/Fireworks ``vendor/name``) put ahead
# of the model name. Used only to recognize the maker boundary and to build a
# letter-first slug when a bare model name starts with a digit; never to rewrite
# a name. Kept deliberately small — an unknown vendor prefix is left in place
# (the model keeps its own canonical slug) rather than guessed at.
_KNOWN_MAKERS = frozenset(
    {
        "ai21",
        "amazon",
        "anthropic",
        "baidu",
        "bytedance",
        "cohere",
        "deepseek",
        "google",
        "luma",
        "meta",
        "microsoft",
        "minimax",
        "mistral",
        "moonshot",
        # Bedrock/Fireworks spell Moonshot and Z.ai as one token in the dotted
        # maker position (``moonshotai.kimi-k2.5``, ``zai.glm-5``); without them
        # the maker is not peeled and the lane mints a vendor-prefixed duplicate
        # instead of merging onto the curated ``kimi-k2.5`` / ``glm-5`` row.
        "moonshotai",
        "nvidia",
        "openai",
        "qwen",
        "stability",
        "thinkingmachines",
        "writer",
        "zai",
    }
)

# Azure Foundry lists Fireworks-origin models as ``fw-<name>``; the marker is a
# serving-lane decoration, not part of the model's identity.
_AZURE_LANE_PREFIXES = ("fw-",)

# The Bedrock colon-version suffix ONLY: an optional ``-v<major>`` immediately
# followed by ``:<minor>``, or a bare trailing ``:<minor>``. A ``-v3`` without a
# colon (e.g. ``deepseek-v3``) is a real version token and is left intact.
_BEDROCK_VERSION_SUFFIX = re.compile(r"(?:-v\d+)?:\d+$")

# A slug must lead with a letter; a size/number-first name (``8x7b-…``) is
# prefixed with its maker to stay callable rather than dropped or merged.
_LETTER_FIRST = re.compile(r"^[a-z]")


@dataclass(frozen=True)
class CanonicalModel:
    """The catalog identity a discovered provider model collapses onto.

    ``slug`` is the public catalog alias (the ``public.models.slug``); two
    serving lanes share one catalog row exactly when they share this slug.
    ``display_name`` is provider-agnostic — the serving lane lives on the
    ``model_providers`` row, never in the model's name.
    """

    slug: str
    display_name: str


def canonicalize(provider: str, provider_model_id: str, display_name: str) -> CanonicalModel:
    """Derive the canonical catalog identity for one discovered provider model.

    Args:
        provider: The serving-lane provider key (``fireworks`` / ``bedrock`` /
            ``azure_openai`` / ``openrouter``); scopes the Azure ``fw-`` strip.
        provider_model_id: The model's id on that provider's wire.
        display_name: The discovered display name, used only as a fallback when
            the wire id yields no usable name.

    Returns:
        The canonical slug and provider-agnostic display name. Slugs are
        deterministic, so the same real model discovered on two lanes yields the
        same slug and merges; different sizes/versions yield different slugs.
    """
    maker, base = _split_maker(provider, provider_model_id)
    normalized = _normalize_token(base)
    if not normalized:
        # A wire id that normalizes away entirely (punctuation only) falls back
        # to the display name, then to a provider-namespaced slug that never
        # merges — the conservative floor.
        normalized = _normalize_token(display_name)
    if not normalized:
        normalized = provider
    slug = _letter_first_slug(normalized, maker, provider)
    return CanonicalModel(slug=slug[:_SLUG_MAX].rstrip("-._"), display_name=_prettify(normalized))


def _normalize_token(value: str) -> str:
    """Lowercase, fold non-slug chars to dashes, keep dots, trim separators."""
    normalized = _SLUG_NONWORD.sub("-", value.lower())
    normalized = _SLUG_DOT_RUN.sub(".", normalized)
    return normalized.strip("-.")


def _split_maker(provider: str, provider_model_id: str) -> tuple[str | None, str]:
    """Return (maker, base model name) after stripping serving-lane decorations."""
    identifier = provider_model_id.strip()
    for path in _FIREWORKS_PATHS:
        if identifier.startswith(path):
            identifier = identifier[len(path) :]
            break

    maker: str | None = None
    if "/" in identifier:
        # ``vendor/name`` (OpenRouter, Fireworks HF-style): the tail is the name.
        vendor, _, tail = identifier.rpartition("/")
        vendor_key = _SLUG_NONWORD.sub("", vendor.lower())
        maker = vendor_key if vendor_key in _KNOWN_MAKERS else None
        identifier = tail
    elif "." in identifier:
        maker, identifier = _split_dotted(identifier)

    if provider == "azure_openai":
        for prefix in _AZURE_LANE_PREFIXES:
            if identifier.lower().startswith(prefix) and len(identifier) > len(prefix):
                identifier = identifier[len(prefix) :]
                break

    if maker is not None:
        identifier = _BEDROCK_VERSION_SUFFIX.sub("", identifier)
    return maker, identifier


def _split_dotted(identifier: str) -> tuple[str | None, str]:
    """Split a Bedrock-style ``[region.]maker.name`` id into (maker, name).

    Only a leading region token and a recognized maker token are peeled; a dot
    inside a version (``gpt-3.5``) is left untouched because its leading segment
    is not a known maker.
    """
    parts = identifier.split(".")
    index = 0
    if len(parts) > 2 and parts[0].lower() in _BEDROCK_REGIONS:
        index = 1
    head = parts[index].lower()
    if head in _KNOWN_MAKERS and index + 1 < len(parts):
        return head, ".".join(parts[index + 1 :])
    return None, identifier


def _letter_first_slug(normalized: str, maker: str | None, provider: str) -> str:
    """Ensure a letter-first slug; a number-first name keeps its maker/lane."""
    if _LETTER_FIRST.match(normalized):
        return normalized
    if maker is not None:
        return f"{maker}-{normalized}"
    # No maker to anchor a number-first name: fall back to the provider
    # namespace, which is letter-first and never merges across lanes.
    return f"{provider}-{normalized}"


def _prettify(normalized: str) -> str:
    """A readable provider-agnostic display name from a normalized slug.

    Words capitalize; a size/parameter token (``70b``, ``8x22b``) upper-cases so
    it reads as a spec rather than a word. Only used when no curated display name
    already exists on the merged row.
    """
    words = [word for word in normalized.split("-") if word]
    return " ".join(_pretty_word(word) for word in words)


def _pretty_word(word: str) -> str:
    """Capitalize a name word; upper-case a parameter-count token."""
    if any(char.isdigit() for char in word) and word[-1].isalpha():
        return word.upper()
    return word.capitalize()
