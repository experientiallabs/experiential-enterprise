# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the deterministic natural-language usage-query engine."""

from __future__ import annotations

import pytest

from explabs.api.insights_query import (
    InsightDimension,
    InsightMetric,
    InsightUnit,
    InsightWindow,
    answer_insight_query,
    not_understood_answer,
    parse_insight_query,
)
from explabs.db.stores.gateway_usage_store import (
    GatewayEventStatus,
    GatewayKeyModelUsageRow,
    GatewayLane,
    GatewayUsageBucketRow,
    GatewayUsageEventRow,
)


def _bucket(
    alias: str,
    *,
    lane: GatewayLane | None = GatewayLane.PLATFORM_FUNDED,
    requests: int = 10,
    errors: int = 0,
    input_tokens: int = 1_000,
    output_tokens: int = 500,
    charged_micro: int = 2_000_000,
    estimated_micro: int = 0,
) -> GatewayUsageBucketRow:
    """One timeseries cell for a model."""
    return GatewayUsageBucketRow(
        bucket_start="2026-08-18T00:00:00+00:00",
        alias=alias,
        lane=lane,
        request_count=requests,
        error_count=errors,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_micro_usd=charged_micro,
        estimated_cost_micro_usd=estimated_micro,
    )


def _event(
    provider: str | None,
    *,
    status: GatewayEventStatus = GatewayEventStatus.COMPLETED,
    charged_micro: int = 100_000,
) -> GatewayUsageEventRow:
    """One request-log row attributed to a provider."""
    return GatewayUsageEventRow(
        request_id="req-1",
        api_key_id="key-1",
        key_label="agent-a",
        alias="gpt-5.6-terra",
        provider=provider,
        lane=GatewayLane.PLATFORM_FUNDED,
        input_tokens=100,
        output_tokens=50,
        cost_micro_usd=charged_micro,
        estimated_cost_micro_usd=0,
        latency_ms=1_200,
        status=status,
        attempt_count=1,
        created_at="2026-08-18T00:00:00+00:00",
    )


def _key_row(
    label: str | None,
    *,
    api_key_id: str | None = "00000000-0000-0000-0000-000000000001",
    requests: int = 5,
    charged_micro: int = 500_000,
) -> GatewayKeyModelUsageRow:
    """One per-key rollup row for an agent."""
    return GatewayKeyModelUsageRow(
        api_key_id=api_key_id,
        key_label=label,
        alias="gpt-5.6-terra",
        request_count=requests,
        error_count=0,
        input_tokens=100,
        output_tokens=50,
        cost_micro_usd=charged_micro,
        estimated_cost_micro_usd=0,
        last_used_at="2026-08-18T00:00:00+00:00",
    )


def test_parse_which_model_cost_the_most_last_week() -> None:
    """Spend-by-model with a weekly window from a natural question."""
    query = parse_insight_query("Which model cost me the most last week?")
    assert query is not None
    assert query.metric is InsightMetric.SPEND
    assert query.dimension is InsightDimension.MODEL
    assert query.window is InsightWindow.WEEK


def test_parse_error_rate_by_provider() -> None:
    """Error metric plus an explicit provider dimension."""
    query = parse_insight_query("show my error rate by provider")
    assert query is not None
    assert query.metric is InsightMetric.ERRORS
    assert query.dimension is InsightDimension.PROVIDER
    assert query.window is InsightWindow.WEEK


def test_parse_total_spend_last_24h() -> None:
    """A "how much did I spend" question is a total over the 24h window."""
    query = parse_insight_query("how much did I spend in the last 24 hours?")
    assert query is not None
    assert query.metric is InsightMetric.SPEND
    assert query.dimension is InsightDimension.TOTAL
    assert query.window is InsightWindow.DAY


def test_parse_tokens_this_month_beats_use_cue() -> None:
    """The specific token cue wins over the broader "use" cue."""
    query = parse_insight_query("how many tokens did I use this month")
    assert query is not None
    # "tokens" is the more specific cue and wins over "use".
    assert query.metric is InsightMetric.TOKENS
    assert query.window is InsightWindow.MONTH


def test_parse_busiest_agent() -> None:
    """A "most requests" question by agent maps to the requests metric."""
    query = parse_insight_query("which agent made the most requests")
    assert query is not None
    assert query.metric is InsightMetric.REQUESTS
    assert query.dimension is InsightDimension.AGENT


def test_parse_unparseable_returns_none() -> None:
    """A question naming no metric (or empty) does not parse."""
    assert parse_insight_query("what's the weather in Paris?") is None
    assert parse_insight_query("   ") is None


def test_answer_spend_by_model_ranks_and_headlines() -> None:
    """Rows rank by spend and the estimate rides its own row."""
    query = parse_insight_query("which model cost me the most?")
    assert query is not None
    buckets = (
        _bucket("gpt-5.6-terra", charged_micro=9_000_000),
        _bucket("claude-fable-5", charged_micro=3_000_000, estimated_micro=1_000_000),
    )
    answer = answer_insight_query(query, buckets, (), ())
    assert answer.understood
    assert answer.unit is InsightUnit.USD
    assert answer.rows[0].label == "gpt-5.6-terra"
    assert answer.rows[0].value == pytest.approx(9.0)
    # The pass-through estimate is surfaced on the row it applies to.
    assert answer.rows[1].detail is not None
    assert "est. pass-through" in answer.rows[1].detail
    assert "gpt-5.6-terra" in answer.headline


def test_answer_error_rate_by_provider_reads_events_with_caveat() -> None:
    """Provider answers read the event sample and carry a caveat."""
    query = parse_insight_query("error rate by provider")
    assert query is not None
    events = (
        _event("openai", status=GatewayEventStatus.FAILED),
        _event("openai", status=GatewayEventStatus.COMPLETED),
        _event("anthropic", status=GatewayEventStatus.COMPLETED),
    )
    answer = answer_insight_query(query, (), events, ())
    assert answer.unit is InsightUnit.PERCENT
    assert answer.caveat is not None
    top = answer.rows[0]
    assert top.label == "openai"
    assert top.value == pytest.approx(50.0)
    assert top.detail == "1 of 2"


def test_answer_total_spend_headline() -> None:
    """A total answer sums the window into one row and headline."""
    query = parse_insight_query("how much did I spend last week?")
    assert query is not None
    buckets = (_bucket("gpt-5.6-terra", charged_micro=4_500_000),)
    answer = answer_insight_query(query, buckets, (), ())
    assert answer.dimension is InsightDimension.TOTAL
    assert len(answer.rows) == 1
    assert answer.rows[0].label == "Total"
    assert "$4.50" in answer.headline


def test_answer_agent_dimension_labels_deleted_key() -> None:
    """A key with no label and no id reads as a deleted key."""
    query = parse_insight_query("spend by agent")
    assert query is not None
    rows = (_key_row(None, api_key_id=None, charged_micro=250_000),)
    answer = answer_insight_query(query, (), (), rows)
    assert answer.rows[0].label == "(deleted key)"


def test_answer_agent_dimension_does_not_merge_keys_sharing_a_label() -> None:
    """Two API keys with the same display name stay distinct agents."""
    query = parse_insight_query("spend by agent")
    assert query is not None
    rows = (
        _key_row("ci", api_key_id="key-aaaaaaaa", charged_micro=250_000),
        _key_row("ci", api_key_id="key-bbbbbbbb", charged_micro=750_000),
    )
    answer = answer_insight_query(query, (), (), rows)
    # Not collapsed into one agent: two rows, disambiguated by a short id.
    assert len(answer.rows) == 2
    assert {row.label for row in answer.rows} == {"ci (key-aaaa)", "ci (key-bbbb)"}


def test_answer_understood_but_no_data() -> None:
    """An understood query with no usage returns empty rows."""
    query = parse_insight_query("spend by model last week")
    assert query is not None
    answer = answer_insight_query(query, (), (), ())
    assert answer.understood
    assert answer.rows == ()
    assert "no model usage" in answer.headline


def test_not_understood_offers_examples() -> None:
    """The fallback answer carries example questions."""
    answer = not_understood_answer()
    assert not answer.understood
    assert answer.rows == ()
    assert len(answer.examples) > 0
