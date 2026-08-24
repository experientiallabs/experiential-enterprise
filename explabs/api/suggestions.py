# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""INTERIM rules engine behind ``GET /api/orgs/{org_id}/suggestions``.

The response models here are the stable contract: the gateway chat's real
suggestions engine later fills exactly this shape, so ``Suggestion`` and
``SuggestionsResponse`` must not change casually. Everything else in this
module — the rule set, the model-family table, the thresholds — is the
deliberately small interim implementation that makes the panel work from
day one, reading nothing but the org's own gateway usage aggregates
(the same rows the Telemetry timeseries and request log serve).

Every dollar figure a rule emits is an estimate derived from the org's
observed token mix and the launch catalog's list prices. Estimates are
labeled as estimates in the evidence lines, never invoiced amounts, and
never clamped — an honest negative would surface as a negative. The caching
rule is a workflow over OBSERVED repeated prompt prefixes (request lineage,
explabs/gateway/lineage.py), so its only assumption is the characters->tokens
conversion and the cache-write premium — both stated verbatim in the evidence
so the arithmetic stays checkable.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.stores.gateway_usage_store import (
    GatewayEventStatus,
    GatewayPromptUsageRow,
    GatewayUsageBucketRow,
    GatewayUsageEventRow,
)
from explabs.platform_launch_models import (
    PLATFORM_LAUNCH_MODEL_CATALOG,
    PlatformLaunchModelMetadata,
)


class SuggestionKind(StrEnum):
    """Vocabulary of the suggestions contract.

    Mirrored by the web client's ``SuggestionKind`` union and the panel's
    per-kind icons (apps/web/lib/types.ts, suggestions-panel.tsx); widening
    this enum requires widening both in the same change.
    """

    CHEAPER_MODEL = "cheaper_model"
    CACHING = "caching"
    LATENCY = "latency"
    QUALITY = "quality"


class Suggestion(BaseModel):
    """One actionable suggestion derived from the org's own usage.

    ``evidence`` lines are plain language and rendered verbatim by the panel;
    they must carry the derivation, sample sizes included, so a customer can
    check the arithmetic. ``estimated_monthly_savings_usd`` is a decimal
    string (an estimate, never an invoiced amount, never clamped) or ``None``
    when the suggestion has no dollar figure.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    kind: SuggestionKind
    title: str
    body: str
    estimated_monthly_savings_usd: str | None
    evidence: tuple[str, ...]


class SuggestionsResponse(BaseModel):
    """The suggestions contract: highest estimated savings first."""

    model_config = ConfigDict(frozen=True)

    suggestions: tuple[Suggestion, ...]


# --- Interim model-family table --------------------------------------------------
#
# "Same family" is a product judgement the launch catalog does not encode, so
# the interim engine carries its own explicit grouping of launch-catalog slugs.
# A model absent from this table simply never triggers the cheaper-model rule.

_MODEL_FAMILIES: dict[str, tuple[str, ...]] = {
    "gpt-5.6": ("gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"),
    "claude-5": ("claude-fable-5", "claude-opus-5", "claude-sonnet-5"),
    "claude-4": ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"),
    "gemini-2.5": ("gemini-2.5-pro", "gemini-2.5-flash"),
    "bedrock-claude": (
        "us.anthropic.claude-opus-4-5-v1:0",
        "us.anthropic.claude-haiku-4-5-v1:0",
    ),
}

_FAMILY_BY_MODEL: dict[str, str] = {
    model: family for family, members in _MODEL_FAMILIES.items() for model in members
}

_CATALOG_BY_MODEL: dict[str, PlatformLaunchModelMetadata] = {
    entry.model: entry for entry in PLATFORM_LAUNCH_MODEL_CATALOG
}


def _catalog_slug(alias: str) -> str:
    """Normalize a ledger alias toward a launch-catalog slug.

    Interim heuristic: gateway aliases are customer-facing model slugs, some
    written provider-prefixed ("anthropic/claude-opus-5"). Anything that still
    misses the catalog after stripping the prefix just never matches a rule.
    """
    return alias.rsplit("/", maxsplit=1)[-1].lower()


class _ModelWindowUsage(BaseModel):
    """One model's rollup across every (bucket, lane) cell in the window."""

    model_config = ConfigDict(frozen=True)

    alias: str
    request_count: int
    error_count: int
    input_tokens: int
    output_tokens: int
    # Cache reads inside input_tokens (a subset, never additive).
    cached_input_tokens: int
    # All-spend in micro-USD: charged credits plus the pass-through estimate.
    spend_micro_usd: int


def _rollup_by_model(rows: tuple[GatewayUsageBucketRow, ...]) -> tuple[_ModelWindowUsage, ...]:
    """Collapse timeseries cells into per-model window totals."""
    grouped: dict[str, list[GatewayUsageBucketRow]] = {}
    for row in rows:
        grouped.setdefault(row.alias, []).append(row)
    return tuple(
        _ModelWindowUsage(
            alias=alias,
            request_count=sum(cell.request_count for cell in cells),
            error_count=sum(cell.error_count for cell in cells),
            input_tokens=sum(cell.input_tokens for cell in cells),
            output_tokens=sum(cell.output_tokens for cell in cells),
            cached_input_tokens=sum(cell.cached_input_tokens for cell in cells),
            spend_micro_usd=sum(
                cell.cost_micro_usd + cell.estimated_cost_micro_usd for cell in cells
            ),
        )
        for alias, cells in grouped.items()
    )


# --- Rule thresholds -------------------------------------------------------------
#
# Interim, deliberately conservative: a suggestion that fires on noise is
# worse than none. The real engine owns smarter triggers.

# cheaper_model: sustained small-request traffic on a model with a strictly
# cheaper same-family option.
_CHEAPER_MIN_REQUESTS = 25
_CHEAPER_MAX_MEAN_TOKENS = 4_000
_CHEAPER_MIN_WINDOW_SPEND_MICRO_USD = 250_000  # $0.25

# caching: one OBSERVED repeated prompt prefix (a lineage group, see
# explabs/gateway/lineage.py) on a model with a cached-input price, where
# almost nothing arrives as a cache read today. The prefix floor matches the
# providers' minimum cacheable prefix, so the advice is never "cache a prompt
# too small to cache".
_CACHING_MIN_REQUESTS = 25
_CACHING_MIN_PREFIX_TOKENS = 1_024
_CACHING_MAX_CACHED_SHARE = 0.20
_CACHING_MIN_WINDOW_SPEND_MICRO_USD = 250_000  # $0.25
# Characters per token for the prefix-size ESTIMATE (stated in the evidence).
_CACHING_CHARS_PER_TOKEN = 4
# Cache writes assumed to bill at this premium over the input rate (Anthropic's
# 5-minute cache); providers with free automatic caching save more. Stated in
# the evidence.
_CACHING_WRITE_PREMIUM = 0.25

# quality: a sustained error rate worth investigating.
_ERRORS_MIN_REQUESTS = 20
_ERRORS_MIN_RATE = 0.10

# latency: p95 over the recent timed requests.
_LATENCY_MIN_TIMED_REQUESTS = 20
_LATENCY_P95_THRESHOLD_MS = 30_000

_WINDOW_DAYS: dict[str, float] = {"24h": 1.0, "7d": 7.0, "30d": 30.0}


def _monthly_factor(window: str) -> float:
    """Scale a window figure to 30 days for the monthly estimate."""
    return 30.0 / _WINDOW_DAYS[window]


def _usd(micro_usd: float) -> float:
    return micro_usd / 1_000_000


def _mtok_cost_micro_usd(
    entry: PlatformLaunchModelMetadata,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int,
) -> float:
    """Cost of a token mix at a catalog entry's list prices, in micro-USD.

    Cached input tokens are a subset of ``input_tokens`` and price at the
    entry's cached-input rate, falling back to the full input rate when the
    entry declares no cached price (same convention as the gateway's cost
    function and the usage-import pricer).
    """
    cached = min(max(cached_input_tokens, 0), input_tokens)
    cached_rate = (
        entry.usd_per_mtok_cached_input
        if entry.usd_per_mtok_cached_input is not None
        else entry.usd_per_mtok_input
    )
    return (
        (input_tokens - cached) * entry.usd_per_mtok_input
        + cached * cached_rate
        + output_tokens * entry.usd_per_mtok_output
    )


def _cheapest_family_alternative(
    slug: str, input_tokens: int, output_tokens: int, cached_input_tokens: int
) -> PlatformLaunchModelMetadata | None:
    """The same-family catalog entry cheapest on the observed mix, if cheaper.

    Requires strictly lower list prices on BOTH token directions, so a
    trade-off model (cheaper input, pricier output) is never presented as a
    saving it might not be.
    """
    family = _FAMILY_BY_MODEL.get(slug)
    current = _CATALOG_BY_MODEL.get(slug)
    if family is None or current is None:
        return None
    candidates = [
        entry
        for member in _MODEL_FAMILIES[family]
        if member != slug
        and (entry := _CATALOG_BY_MODEL[member]).usd_per_mtok_input < current.usd_per_mtok_input
        and entry.usd_per_mtok_output < current.usd_per_mtok_output
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda entry: _mtok_cost_micro_usd(
            entry, input_tokens, output_tokens, cached_input_tokens
        ),
    )


def _cheaper_model_suggestions(
    rollups: tuple[_ModelWindowUsage, ...], window: str
) -> list[Suggestion]:
    """Small-request traffic on a pricey model with a cheaper family option."""
    suggestions: list[Suggestion] = []
    for usage in rollups:
        if usage.request_count < _CHEAPER_MIN_REQUESTS:
            continue
        if usage.spend_micro_usd < _CHEAPER_MIN_WINDOW_SPEND_MICRO_USD:
            continue
        mean_tokens = (usage.input_tokens + usage.output_tokens) / usage.request_count
        if mean_tokens > _CHEAPER_MAX_MEAN_TOKENS:
            continue
        slug = _catalog_slug(usage.alias)
        alternative = _cheapest_family_alternative(
            slug, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens
        )
        if alternative is None:
            continue
        alternative_micro_usd = _mtok_cost_micro_usd(
            alternative, usage.input_tokens, usage.output_tokens, usage.cached_input_tokens
        )
        savings_window_usd = _usd(usage.spend_micro_usd - alternative_micro_usd)
        if savings_window_usd <= 0:
            continue
        monthly_usd = savings_window_usd * _monthly_factor(window)
        mean_input = usage.input_tokens // usage.request_count
        mean_output = usage.output_tokens // usage.request_count
        suggestions.append(
            Suggestion(
                id=f"cheaper_model:{usage.alias}",
                kind=SuggestionKind.CHEAPER_MODEL,
                title=f"Try {alternative.display_name} for small {usage.alias} requests",
                body=(
                    f"Most of your {usage.alias} traffic is small requests. "
                    f"{alternative.display_name} is a cheaper model in the same family "
                    "and typically handles requests of this size well."
                ),
                estimated_monthly_savings_usd=f"{monthly_usd:.2f}",
                evidence=(
                    (
                        f"You made {usage.request_count} requests to {usage.alias} in the "
                        f"last {window}, averaging about {mean_input} input and "
                        f"{mean_output} output tokens each."
                    ),
                    (
                        f"That traffic cost about ${_usd(usage.spend_micro_usd):.2f} in "
                        f"the last {window}."
                    ),
                    (
                        f"The same tokens at {alternative.display_name}'s list prices "
                        f"(${alternative.usd_per_mtok_input:.2f}/M input, "
                        f"${alternative.usd_per_mtok_output:.2f}/M output, cache reads at "
                        "its cached-input price when it has one) would have "
                        f"cost about ${_usd(alternative_micro_usd):.2f}."
                    ),
                    (
                        f"Over 30 days at this pace, that is roughly ${monthly_usd:.2f} — "
                        "an estimate from your recent token mix, not a quote."
                    ),
                ),
            )
        )
    return suggestions


def _caching_suggestions(
    prompts: tuple[GatewayPromptUsageRow, ...], window: str
) -> list[Suggestion]:
    """One observed repeated prompt prefix worth caching, per lineage group.

    This is a check against the org's ACTUAL traffic, not a heuristic: the
    lineage group proves the same system prompt and tool declarations were
    resent on every request, and the group's own request/conversation counts
    drive the read/write arithmetic. The only estimate is characters->tokens,
    stated in the evidence.
    """
    suggestions: list[Suggestion] = []
    for group in prompts:
        if group.request_count < _CACHING_MIN_REQUESTS:
            continue
        spend_micro_usd = group.cost_micro_usd + group.estimated_cost_micro_usd
        if spend_micro_usd < _CACHING_MIN_WINDOW_SPEND_MICRO_USD:
            continue
        entry = _CATALOG_BY_MODEL.get(_catalog_slug(group.alias))
        if entry is None or entry.usd_per_mtok_cached_input is None:
            continue
        prefix_tokens = group.stable_prefix_chars // _CACHING_CHARS_PER_TOKEN
        if prefix_tokens < _CACHING_MIN_PREFIX_TOKENS:
            continue
        if group.input_tokens <= 0:
            continue
        cached_share = group.cached_input_tokens / group.input_tokens
        if cached_share >= _CACHING_MAX_CACHED_SHARE:
            continue
        # Each conversation's first request writes the prefix into the cache;
        # every later request in the group reads it. The write bills at an
        # assumed premium over the input rate (see _CACHING_WRITE_PREMIUM).
        reads = max(group.request_count - group.conversation_count, 0)
        writes = group.conversation_count
        savings_window_micro_usd = prefix_tokens * (
            reads * (entry.usd_per_mtok_input - entry.usd_per_mtok_cached_input)
            - writes * entry.usd_per_mtok_input * _CACHING_WRITE_PREMIUM
        )
        if savings_window_micro_usd <= 0:
            continue
        monthly_usd = _usd(savings_window_micro_usd) * _monthly_factor(window)
        short_group = group.prompt_sha256[:12]
        suggestions.append(
            Suggestion(
                id=f"caching:{group.alias}:{short_group}",
                kind=SuggestionKind.CACHING,
                title=f"Cache your repeated prompt prefix on {group.alias}",
                body=(
                    f"{group.request_count} of your {group.alias} requests resend the "
                    "same system prompt and tool definitions, and almost none of those "
                    "tokens arrive as cache reads. Marking that stable prefix cacheable "
                    "lets the provider's prompt cache serve it at the cached-input price."
                ),
                estimated_monthly_savings_usd=f"{monthly_usd:.2f}",
                evidence=(
                    (
                        f"{group.request_count} requests to {group.alias} in the last "
                        f"{window} repeated one prompt prefix (group {short_group}) of "
                        f"about {prefix_tokens:,} tokens (estimated from "
                        f"{group.stable_prefix_chars:,} characters)."
                    ),
                    (
                        f"They span {group.conversation_count} conversation(s) from "
                        f"{group.agent_count} API key(s); {cached_share:.0%} of the "
                        "group's input tokens arrived as cache reads."
                    ),
                    (
                        f"Serving that prefix from cache on the {reads:,} follow-up "
                        f"requests at ${entry.usd_per_mtok_cached_input:.2f}/M instead "
                        f"of ${entry.usd_per_mtok_input:.2f}/M, minus one cache write "
                        f"per conversation at an assumed 25% premium, would have saved "
                        f"about ${_usd(savings_window_micro_usd):.2f} this window."
                    ),
                    (
                        f"Over 30 days at this pace, that is roughly ${monthly_usd:.2f} "
                        "— an upper-bound estimate from your observed traffic and list "
                        "prices, not a quote: sessions opening with an identical first "
                        "message count as one conversation, and short cache TTLs add "
                        "writes. Providers with free automatic caching save more."
                    ),
                ),
            )
        )
    return suggestions


def _error_rate_suggestions(
    rollups: tuple[_ModelWindowUsage, ...], window: str
) -> list[Suggestion]:
    """A sustained error rate on one model: point at the request log."""
    suggestions: list[Suggestion] = []
    for usage in rollups:
        if usage.request_count < _ERRORS_MIN_REQUESTS:
            continue
        rate = usage.error_count / usage.request_count
        if rate < _ERRORS_MIN_RATE:
            continue
        suggestions.append(
            Suggestion(
                id=f"errors:{usage.alias}",
                kind=SuggestionKind.QUALITY,
                title=f"High error rate on {usage.alias}",
                body=(
                    f"{rate:.0%} of your {usage.alias} requests ended in an error. "
                    "Filter the request log below to errors to see what failed, and "
                    "consider a different provider or model for this traffic."
                ),
                estimated_monthly_savings_usd=None,
                evidence=(
                    (
                        f"{usage.error_count} of {usage.request_count} requests to "
                        f"{usage.alias} in the last {window} did not complete."
                    ),
                    "Errors still count against latency and retries even when they cost nothing.",
                ),
            )
        )
    return suggestions


def _latency_suggestions(events: tuple[GatewayUsageEventRow, ...], window: str) -> list[Suggestion]:
    """High p95 latency over the recent timed requests to one model.

    The usage aggregates carry no latency, so this rule reads the most recent
    request rows the log endpoint serves and says so in the evidence — the
    sample is "recent requests", not the whole window.
    """
    timed: dict[str, list[int]] = {}
    for event in events:
        if event.latency_ms is not None and event.status == GatewayEventStatus.COMPLETED:
            timed.setdefault(event.alias, []).append(event.latency_ms)
    suggestions: list[Suggestion] = []
    for alias, latencies in timed.items():
        if len(latencies) < _LATENCY_MIN_TIMED_REQUESTS:
            continue
        ordered = sorted(latencies)
        p95 = ordered[max(0, -(-95 * len(ordered) // 100) - 1)]
        if p95 < _LATENCY_P95_THRESHOLD_MS:
            continue
        suggestions.append(
            Suggestion(
                id=f"latency:{alias}",
                kind=SuggestionKind.LATENCY,
                title=f"Slow responses from {alias}",
                body=(
                    f"The slowest 5% of recent {alias} requests took "
                    f"{p95 / 1000:.0f}s or more. A faster model in the same family, or "
                    "a lower reasoning effort, usually cuts this sharply."
                ),
                estimated_monthly_savings_usd=None,
                evidence=(
                    (
                        f"p95 latency over your last {len(ordered)} completed "
                        f"{alias} requests was {p95 / 1000:.1f}s (window: {window})."
                    ),
                    "Measured from recent requests only, not the whole window.",
                ),
            )
        )
    return suggestions


def generate_suggestions(
    buckets: tuple[GatewayUsageBucketRow, ...],
    events: tuple[GatewayUsageEventRow, ...],
    window: str,
    prompts: tuple[GatewayPromptUsageRow, ...] = (),
) -> tuple[Suggestion, ...]:
    """Run the interim rules over one org's window of usage aggregates.

    Args:
        buckets: The org's (bucket, model, lane) timeseries cells for the window.
        events: The org's most recent request rows (the log endpoint's page).
        window: Window shorthand ("24h" | "7d" | "30d") for wording and scaling.
        prompts: The org's per-(prompt group, alias) lineage rollups for the
            window; the caching workflow checks these observed repeated
            prefixes. Empty when no lineage-bearing traffic exists yet.

    Returns:
        Suggestions ordered by estimated monthly savings, dollar-less rules last,
        stable id order breaking ties.
    """
    rollups = _rollup_by_model(buckets)
    suggestions = [
        *_cheaper_model_suggestions(rollups, window),
        *_caching_suggestions(prompts, window),
        *_error_rate_suggestions(rollups, window),
        *_latency_suggestions(events, window),
    ]
    suggestions.sort(
        key=lambda suggestion: (
            -(float(suggestion.estimated_monthly_savings_usd or 0.0)),
            suggestion.id,
        )
    )
    return tuple(suggestions)
