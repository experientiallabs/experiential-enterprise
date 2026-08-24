# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the interim suggestions rules engine."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from explabs.api.suggestions import Suggestion, SuggestionKind, generate_suggestions
from explabs.db.stores.gateway_usage_store import (
    GatewayEventStatus,
    GatewayLane,
    GatewayPromptUsageRow,
    GatewayUsageBucketRow,
    GatewayUsageEventRow,
)


def _bucket(**overrides: object) -> GatewayUsageBucketRow:
    row: dict[str, object] = {
        "bucket_start": "2026-08-18T00:00:00+00:00",
        "alias": "claude-fable-5",
        "lane": GatewayLane.PLATFORM_FUNDED,
        "request_count": 30,
        "error_count": 0,
        # 500 input + 100 output tokens per request: small requests.
        "input_tokens": 15_000,
        "output_tokens": 3_000,
        # The observed mix at Fable's list prices ($10/$50 per Mtok) = $0.30.
        "cost_micro_usd": 300_000,
        "estimated_cost_micro_usd": 0,
    }
    row.update(overrides)
    return GatewayUsageBucketRow.model_validate(row)


def _event(index: int, **overrides: object) -> GatewayUsageEventRow:
    row: dict[str, object] = {
        "request_id": f"req-{index}",
        "api_key_id": None,
        "key_label": None,
        "alias": "claude-fable-5",
        "provider": "anthropic",
        "lane": GatewayLane.PLATFORM_FUNDED,
        "input_tokens": 500,
        "output_tokens": 100,
        "cost_micro_usd": 10_000,
        "estimated_cost_micro_usd": 0,
        "latency_ms": 1_200,
        "status": GatewayEventStatus.COMPLETED,
        "attempt_count": 1,
        "created_at": (datetime.now(tz=UTC) - timedelta(minutes=index)).isoformat(),
    }
    row.update(overrides)
    return GatewayUsageEventRow.model_validate(row)


def _by_kind(suggestions: tuple[Suggestion, ...], kind: SuggestionKind) -> list[Suggestion]:
    return [suggestion for suggestion in suggestions if suggestion.kind == kind]


def test_small_requests_on_a_pricey_model_suggest_the_cheaper_family_option() -> None:
    """Skewed small-request Fable traffic yields a Sonnet suggestion with math."""
    suggestions = generate_suggestions((_bucket(),), (), "7d")
    cheaper = _by_kind(suggestions, SuggestionKind.CHEAPER_MODEL)
    assert len(cheaper) == 1
    suggestion = cheaper[0]
    assert suggestion.id == "cheaper_model:claude-fable-5"
    # Sonnet 5 is the cheapest same-family entry on this mix (not Haiku 4.5,
    # which sits in the claude-4 family).
    assert "Claude Sonnet 5" in suggestion.title
    # Window savings $0.30 - $0.09 = $0.21, scaled 7d -> 30d.
    assert suggestion.estimated_monthly_savings_usd == "0.90"
    assert any("estimate" in line for line in suggestion.evidence)
    assert any("30 requests" in line for line in suggestion.evidence)


def test_savings_math_reads_the_split_spend_and_scales_by_window() -> None:
    """BYOK estimates count as spend, and a 24h window scales by 30."""
    bucket = _bucket(
        lane=GatewayLane.PASS_THROUGH, cost_micro_usd=0, estimated_cost_micro_usd=300_000
    )
    suggestions = generate_suggestions((bucket,), (), "24h")
    cheaper = _by_kind(suggestions, SuggestionKind.CHEAPER_MODEL)
    assert len(cheaper) == 1
    assert cheaper[0].estimated_monthly_savings_usd == "6.30"


def test_quiet_or_large_request_traffic_stays_silent() -> None:
    """Too few requests, too little spend, or big requests: no suggestion."""
    few = _bucket(request_count=10, input_tokens=5_000, output_tokens=1_000)
    assert generate_suggestions((few,), (), "7d") == ()
    cheap_spend = _bucket(cost_micro_usd=100_000)
    assert generate_suggestions((cheap_spend,), (), "7d") == ()
    large_requests = _bucket(input_tokens=600_000, output_tokens=120_000, cost_micro_usd=12_000_000)
    assert (
        _by_kind(generate_suggestions((large_requests,), (), "7d"), SuggestionKind.CHEAPER_MODEL)
        == []
    )


def test_models_outside_the_launch_catalog_never_match_the_cheaper_rule() -> None:
    """An unknown alias cannot be priced, so no savings claim is made about it."""
    unknown = _bucket(alias="mystery-model")
    assert _by_kind(generate_suggestions((unknown,), (), "7d"), SuggestionKind.CHEAPER_MODEL) == []


def test_provider_prefixed_aliases_normalize_to_catalog_slugs() -> None:
    """A provider-prefixed alias still matches its catalog entry."""
    prefixed = _bucket(alias="anthropic/claude-fable-5")
    cheaper = _by_kind(generate_suggestions((prefixed,), (), "7d"), SuggestionKind.CHEAPER_MODEL)
    assert len(cheaper) == 1
    assert cheaper[0].id == "cheaper_model:anthropic/claude-fable-5"


def test_family_floor_models_get_no_cheaper_suggestion() -> None:
    """The cheapest member of a family has nowhere cheaper to go."""
    floor = _bucket(alias="gpt-5.6-luna", cost_micro_usd=300_000)
    assert _by_kind(generate_suggestions((floor,), (), "7d"), SuggestionKind.CHEAPER_MODEL) == []


def test_cheaper_model_prices_cache_reads_at_the_alternative_cached_rate() -> None:
    """Cache reads price at the alternative's cached-input rate, not full price."""
    cached = _bucket(cached_input_tokens=10_000)
    suggestions = generate_suggestions((cached,), (), "7d")
    cheaper = _by_kind(suggestions, SuggestionKind.CHEAPER_MODEL)
    assert len(cheaper) == 1
    # Sonnet 5 on the mix: 5,000 fresh * $3/M + 10,000 cached * $0.30/M
    # + 3,000 output * $15/M = $0.063. Window savings $0.30 - $0.063 = $0.237,
    # scaled 7d -> 30d.
    assert cheaper[0].estimated_monthly_savings_usd == "1.02"


def _prompt(**overrides: object) -> GatewayPromptUsageRow:
    row: dict[str, object] = {
        "prompt_sha256": "ab12" * 16,
        "alias": "claude-fable-5",
        # 30 requests across 5 conversations: 25 cache reads, 5 cache writes.
        "request_count": 30,
        "error_count": 0,
        "conversation_count": 5,
        "agent_count": 2,
        "input_tokens": 90_000,
        "output_tokens": 3_000,
        "cached_input_tokens": 0,
        "cost_micro_usd": 300_000,
        "estimated_cost_micro_usd": 0,
        # ~2,000 estimated tokens of system prompt + tools.
        "stable_prefix_chars": 8_000,
        "last_used_at": "2026-08-21T00:00:00+00:00",
    }
    row.update(overrides)
    return GatewayPromptUsageRow.model_validate(row)


def test_observed_repeated_prefix_yields_a_group_scoped_caching_suggestion() -> None:
    """A lineage group with an uncached repeated prefix carries checkable math."""
    suggestions = generate_suggestions((), (), "7d", prompts=(_prompt(),))
    caching = _by_kind(suggestions, SuggestionKind.CACHING)
    assert len(caching) == 1
    suggestion = caching[0]
    assert suggestion.id == "caching:claude-fable-5:ab12ab12ab12"
    # 2,000-token prefix; 25 follow-up reads at $1/M instead of $10/M minus 5
    # writes at a 25% premium over $10/M: $0.425 the window, scaled 7d -> 30d.
    assert suggestion.estimated_monthly_savings_usd == "1.82"
    assert any("2,000 tokens" in line for line in suggestion.evidence)
    assert any("25 follow-up" in line for line in suggestion.evidence)
    assert any("group ab12ab12ab12" in line for line in suggestion.evidence)
    assert any("estimate" in line for line in suggestion.evidence)


def test_caching_workflow_respects_its_gates() -> None:
    """Cached, small-prefix, priceless, quiet, or write-heavy groups stay silent."""
    # A fifth-plus of input already arrives cached: nothing to suggest.
    warm = _prompt(cached_input_tokens=20_000)
    assert (
        _by_kind(generate_suggestions((), (), "7d", prompts=(warm,)), SuggestionKind.CACHING) == []
    )
    # A prefix below the providers' minimum cacheable size.
    tiny = _prompt(stable_prefix_chars=2_000)
    assert (
        _by_kind(generate_suggestions((), (), "7d", prompts=(tiny,)), SuggestionKind.CACHING) == []
    )
    # The gpt-5.6 catalog entries declare no cached-input price.
    unpriced = _prompt(alias="gpt-5.6-sol")
    assert (
        _by_kind(generate_suggestions((), (), "7d", prompts=(unpriced,)), SuggestionKind.CACHING)
        == []
    )
    # Too few requests to matter.
    quiet = _prompt(request_count=10, conversation_count=3)
    assert (
        _by_kind(generate_suggestions((), (), "7d", prompts=(quiet,)), SuggestionKind.CACHING) == []
    )
    # Nearly every request opens a new conversation: cache writes eat the
    # savings, and an honest negative estimate is suppressed, not clamped up.
    churn = _prompt(request_count=26, conversation_count=25)
    assert (
        _by_kind(generate_suggestions((), (), "7d", prompts=(churn,)), SuggestionKind.CACHING) == []
    )


def test_sustained_error_rate_yields_a_quality_suggestion() -> None:
    """20% errors over enough requests points at the request log."""
    noisy = _bucket(request_count=25, error_count=5, cost_micro_usd=0)
    suggestions = generate_suggestions((noisy,), (), "7d")
    quality = _by_kind(suggestions, SuggestionKind.QUALITY)
    assert len(quality) == 1
    assert quality[0].id == "errors:claude-fable-5"
    assert quality[0].estimated_monthly_savings_usd is None
    assert any("5 of 25" in line for line in quality[0].evidence)
    # Below the rate threshold: silent.
    steady = _bucket(request_count=25, error_count=2, cost_micro_usd=0)
    assert _by_kind(generate_suggestions((steady,), (), "7d"), SuggestionKind.QUALITY) == []


def test_high_p95_latency_over_enough_timed_requests_fires() -> None:
    """p95 over the recent completed requests crossing 30s yields a suggestion."""
    slow = tuple(_event(index, latency_ms=45_000) for index in range(25))
    suggestions = generate_suggestions((), slow, "7d")
    latency = _by_kind(suggestions, SuggestionKind.LATENCY)
    assert len(latency) == 1
    assert latency[0].id == "latency:claude-fable-5"
    assert any("last 25" in line for line in latency[0].evidence)
    # Too small a sample stays silent, however slow.
    assert generate_suggestions((), slow[:10], "7d") == ()
    # Fast traffic stays silent, and failed rows never count as timings.
    fast = tuple(_event(index, latency_ms=900) for index in range(25))
    assert generate_suggestions((), fast, "7d") == ()
    failed_slow = tuple(
        _event(index, latency_ms=45_000, status=GatewayEventStatus.FAILED) for index in range(25)
    )
    assert generate_suggestions((), failed_slow, "7d") == ()


def test_suggestions_order_by_estimated_savings_with_dollarless_last() -> None:
    """Money-backed suggestions lead; rules without a dollar figure follow."""
    buckets = (
        _bucket(request_count=25, error_count=5),
        _bucket(
            alias="gpt-5.6-sol",
            request_count=30,
            input_tokens=15_000,
            output_tokens=3_000,
            # $5/$30 per Mtok on the same mix = $0.165... use a bigger spend.
            cost_micro_usd=1_000_000,
        ),
    )
    suggestions = generate_suggestions(buckets, (), "7d")
    kinds = [suggestion.kind for suggestion in suggestions]
    assert kinds[0] == SuggestionKind.CHEAPER_MODEL
    assert SuggestionKind.QUALITY in kinds
    assert kinds.index(SuggestionKind.QUALITY) > 0
