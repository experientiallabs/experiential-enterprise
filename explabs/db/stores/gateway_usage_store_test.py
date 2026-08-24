# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the gateway usage-ledger read store."""

from __future__ import annotations

from typing import ClassVar, cast

import pytest
from pydantic import ValidationError

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import SupabaseClient
from explabs.db.stores.gateway_usage_store import (
    GatewayLane,
    GatewayUsageEventRow,
    GatewayUsageStore,
    _aggregation_cache,
    _AggregationCache,
)

ORG_ID = "org-1"
OTHER_ORG_ID = "org-2"
KEY_PROD = "11111111-0000-4000-8000-000000000001"
KEY_CLI = "11111111-0000-4000-8000-000000000002"


def _store() -> tuple[GatewayUsageStore, FakeSupabaseClient]:
    client = FakeSupabaseClient()
    client.tables["api_keys"] = [
        {"id": KEY_PROD, "org_id": ORG_ID, "name": "prod-agent"},
    ]
    return GatewayUsageStore(client), client


def _event_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "request_id": "req-1",
        "org_id": ORG_ID,
        "api_key_id": KEY_PROD,
        "user_id": None,
        "alias": "haiku",
        "provider": "anthropic",
        "lane": "platform_funded",
        "input_tokens": 100,
        "output_tokens": 20,
        "cost_micro_usd": 3000,
        "estimated_cost_micro_usd": 0,
        "latency_ms": 400,
        "status": "completed",
        "attempt_count": 1,
        "day": "2026-08-19",
        "created_at": "2026-08-19T10:05:00+00:00",
    }
    row.update(overrides)
    return row


def test_timeseries_groups_by_bucket_alias_and_lane() -> None:
    """Cells collapse per (epoch-floor bucket, alias, lane) with honest sums."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id="req-1"),
        _event_row(
            request_id="req-2",
            status="failed",
            input_tokens=50,
            output_tokens=0,
            cost_micro_usd=0,
            created_at="2026-08-19T10:25:00+00:00",
        ),
        _event_row(
            request_id="req-3",
            alias="sonnet",
            provider="openai",
            lane="pass_through",
            cost_micro_usd=0,
            estimated_cost_micro_usd=9000,
            created_at="2026-08-19T11:05:00+00:00",
        ),
        _event_row(request_id="req-elsewhere", org_id=OTHER_ORG_ID),
    ]
    buckets = store.usage_timeseries(ORG_ID, bucket_seconds=3_600)
    assert [(cell.alias, cell.lane) for cell in buckets] == [
        ("haiku", GatewayLane.PLATFORM_FUNDED),
        ("sonnet", GatewayLane.PASS_THROUGH),
    ]
    haiku = buckets[0]
    assert haiku.bucket_start == "2026-08-19T10:00:00+00:00"
    assert haiku.request_count == 2
    assert haiku.error_count == 1
    assert haiku.input_tokens == 150
    assert haiku.output_tokens == 20
    assert haiku.cost_micro_usd == 3000
    assert haiku.estimated_cost_micro_usd == 0
    # The pass-through lane carries only the never-charged estimate.
    sonnet = buckets[1]
    assert sonnet.cost_micro_usd == 0
    assert sonnet.estimated_cost_micro_usd == 9000


def test_timeseries_filters_compose() -> None:
    """Alias, key, and lane filters narrow the timeseries."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id="req-1"),
        _event_row(request_id="req-2", api_key_id=KEY_CLI, alias="sonnet", lane="pass_through"),
    ]
    assert len(store.usage_timeseries(ORG_ID, alias="sonnet")) == 1
    assert len(store.usage_timeseries(ORG_ID, api_key_id=KEY_PROD)) == 1
    only_byok = store.usage_timeseries(ORG_ID, lane=GatewayLane.PASS_THROUGH)
    assert [cell.alias for cell in only_byok] == ["sonnet"]


def test_by_key_joins_labels_and_survives_key_deletion() -> None:
    """The rollup groups per (key, alias); a deleted key keeps a null label."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id="req-1"),
        _event_row(request_id="req-2", status="failed", created_at="2026-08-19T12:00:00+00:00"),
        _event_row(request_id="req-3", api_key_id=KEY_CLI, alias="sonnet"),
    ]
    rows = store.usage_by_key(ORG_ID)
    assert [(row.api_key_id, row.alias) for row in rows] == [
        (KEY_PROD, "haiku"),
        (KEY_CLI, "sonnet"),
    ]
    prod = rows[0]
    assert prod.key_label == "prod-agent"
    assert prod.request_count == 2
    assert prod.error_count == 1
    assert prod.last_used_at == "2026-08-19T12:00:00+00:00"
    assert rows[1].key_label is None


def test_list_events_pages_and_filters() -> None:
    """The event log lists newest first, filters, and pages by keyset cursor."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id=f"req-{index}", created_at=f"2026-08-19T1{index}:00:00+00:00")
        for index in range(3)
    ]
    first_page = store.list_events(ORG_ID, limit=2)
    assert [event.request_id for event in first_page] == ["req-2", "req-1"]
    assert first_page[0].key_label == "prod-agent"
    assert first_page[0].attempt_count == 1
    second_page = store.list_events(
        ORG_ID,
        limit=2,
        cursor_ts=first_page[-1].created_at,
        cursor_id=first_page[-1].request_id,
    )
    assert [event.request_id for event in second_page] == ["req-0"]


def test_list_events_reads_tool_names_and_defaults_to_none() -> None:
    """The event log parses tools_used when present and reads None otherwise."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(
            request_id="req-tools",
            tools_used=["search", "fetch"],
            created_at="2026-08-19T12:00:00+00:00",
        ),
        _event_row(request_id="req-none", created_at="2026-08-19T11:00:00+00:00"),
    ]
    events = {event.request_id: event for event in store.list_events(ORG_ID)}
    assert events["req-tools"].tools_used == ("search", "fetch")
    # A row without the column (the current, WMO-not-yet-surfacing state).
    assert events["req-none"].tools_used is None


def test_list_events_reads_metadata_and_outcome_reason() -> None:
    """The event log parses the token breakdown, pricing, and failure reason."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(
            request_id="req-full",
            cached_input_tokens=40,
            reasoning_tokens=12,
            pricing_known=True,
            created_at="2026-08-19T12:00:00+00:00",
        ),
        _event_row(
            request_id="req-failed",
            status="failed",
            pricing_known=False,
            failure_class="provider_internal",
            error_message="upstream 500",
            created_at="2026-08-19T11:00:00+00:00",
        ),
    ]
    events = {event.request_id: event for event in store.list_events(ORG_ID)}
    full = events["req-full"]
    assert (full.cached_input_tokens, full.reasoning_tokens) == (40, 12)
    assert full.pricing_known is True
    assert full.failure_class is None
    assert full.error_message is None
    failed = events["req-failed"]
    assert failed.pricing_known is False
    assert failed.failure_class == "provider_internal"
    assert failed.error_message == "upstream 500"


def test_list_events_reads_ttft_and_defaults_to_none() -> None:
    """The event log parses ttft_ms when captured and reads None otherwise."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(
            request_id="req-ttft",
            ttft_ms=420,
            created_at="2026-08-19T12:00:00+00:00",
        ),
        # A row settled before TTFT capture shipped (or with no first token
        # observed): NULL, never zero.
        _event_row(request_id="req-none", created_at="2026-08-19T11:00:00+00:00"),
    ]
    events = {event.request_id: event for event in store.list_events(ORG_ID)}
    assert events["req-ttft"].ttft_ms == 420
    assert events["req-none"].ttft_ms is None


def test_null_api_key_groups_alone_with_null_label() -> None:
    """A key hard-deleted before settlement (null id) stays readable."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id="req-1"),
        _event_row(request_id="req-orphan", api_key_id=None),
    ]
    rows = store.usage_by_key(ORG_ID)
    orphan = next(row for row in rows if row.api_key_id is None)
    assert orphan.key_label is None
    assert orphan.request_count == 1
    events = store.list_events(ORG_ID)
    assert {event.api_key_id for event in events} == {KEY_PROD, None}


def test_list_events_error_shorthand_selects_non_completed() -> None:
    """``status="error"`` matches every terminal state except completed."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id="req-ok"),
        _event_row(request_id="req-failed", status="failed"),
        _event_row(request_id="req-crash", status="unknown_after_crash"),
    ]
    errors = store.list_events(ORG_ID, status="error")
    assert {event.request_id for event in errors} == {"req-failed", "req-crash"}


def test_event_row_rejects_unknown_status_and_lane() -> None:
    """Values outside the ledger vocabulary fail at the typed boundary."""
    with pytest.raises(ValidationError):
        GatewayUsageEventRow.from_row(_event_row(status="ok"))
    with pytest.raises(ValidationError):
        GatewayUsageEventRow.from_row(_event_row(lane="byok"))


def test_by_provider_groups_platforms_and_keeps_the_null_group() -> None:
    """One row per provider, with undispatched traffic under ``None``."""
    store, client = _store()
    client.tables["gateway_usage_events"] = [
        _event_row(request_id="req-1"),
        _event_row(request_id="req-2", status="failed", cost_micro_usd=0),
        _event_row(
            request_id="req-3",
            provider="openai",
            lane="pass_through",
            cost_micro_usd=0,
            estimated_cost_micro_usd=9_000,
        ),
        _event_row(
            request_id="req-4",
            provider=None,
            lane=None,
            status="failed",
            attempt_count=0,
        ),
    ]
    rows = store.usage_by_provider(ORG_ID)
    by_provider = {row.provider: row for row in rows}
    assert set(by_provider) == {"anthropic", "openai", None}
    assert by_provider["anthropic"].request_count == 2
    assert by_provider["anthropic"].error_count == 1
    assert by_provider["openai"].estimated_cost_micro_usd == 9_000
    assert by_provider[None].request_count == 1


@pytest.fixture(autouse=True)
def _reset_aggregation_cache() -> None:
    """Isolate the process-wide usage-aggregate cache between tests."""
    _aggregation_cache.clear()


def test_aggregation_cache_returns_value_within_ttl() -> None:
    """A fresh entry is served for the whole TTL window."""
    cache = _AggregationCache(ttl_seconds=10.0)
    cache.put("k", ("value",), monotonic=100.0)
    assert cache.get("k", monotonic=109.9) == ("value",)


def test_aggregation_cache_expires_after_ttl() -> None:
    """The entry is gone once the TTL elapses, so new usage surfaces."""
    cache = _AggregationCache(ttl_seconds=10.0)
    cache.put("k", ("value",), monotonic=100.0)
    assert cache.get("k", monotonic=110.1) is None


def test_aggregation_cache_miss_for_unknown_key() -> None:
    """An unseen key is a miss, never another key's value."""
    assert _AggregationCache().get("nope", monotonic=1.0) is None


class _RpcResult:
    """Minimal PostgREST-shaped result with an empty row list."""

    data: ClassVar[list[dict[str, object]]] = []


class _CountingClient:
    """Stub Supabase client counting rpc invocations for cache-hit assertions."""

    def __init__(self) -> None:
        self.rpc_calls: list[tuple[str, dict[str, object]]] = []

    def rpc(self, name: str, params: dict[str, object]) -> _CountingClient:
        self.rpc_calls.append((name, dict(params)))
        return self

    def execute(self) -> _RpcResult:
        return _RpcResult()


def test_usage_timeseries_serves_repeat_calls_from_cache() -> None:
    """A second identical call within the TTL does not re-hit the RPC."""
    client = _CountingClient()
    store = GatewayUsageStore(cast("SupabaseClient", client))
    store.usage_timeseries(ORG_ID, after="2026-08-01T00:00:00+00:00")
    store.usage_timeseries(ORG_ID, after="2026-08-01T00:00:00+00:00")
    assert len(client.rpc_calls) == 1


def test_usage_timeseries_cache_is_scoped_to_args() -> None:
    """Different windows/orgs are distinct cache keys, so each hits the RPC."""
    client = _CountingClient()
    store = GatewayUsageStore(cast("SupabaseClient", client))
    store.usage_timeseries(ORG_ID, after="2026-08-01T00:00:00+00:00")
    store.usage_timeseries(ORG_ID, after="2026-08-02T00:00:00+00:00")
    store.usage_timeseries(OTHER_ORG_ID, after="2026-08-01T00:00:00+00:00")
    assert len(client.rpc_calls) == 3


def test_usage_by_key_serves_repeat_calls_from_cache() -> None:
    """The by-key rollup is cached on the same (org, window) key."""
    client = _CountingClient()
    store = GatewayUsageStore(cast("SupabaseClient", client))
    store.usage_by_key(ORG_ID, after="2026-08-01T00:00:00+00:00")
    store.usage_by_key(ORG_ID, after="2026-08-01T00:00:00+00:00")
    assert len(client.rpc_calls) == 1


# ---------------------------------------------------------------------------
# Deep Insights aggregation (gateway_insights_* RPCs).

from explabs.db.stores.gateway_usage_store import (  # noqa: E402
    GatewayInsightsGroupBy,
    GatewayInsightsMetricRow,
    GatewayTokensPerSecondRow,
    GatewayTopAppRow,
)

KEY_APP_B = "11111111-0000-4000-8000-000000000003"


def _insights_store() -> GatewayUsageStore:
    """A store seeded with two live keys and a spread of deep-telemetry events."""
    client = FakeSupabaseClient()
    client.tables["api_keys"] = [
        {"id": KEY_PROD, "org_id": ORG_ID, "name": "prod-agent"},
        {"id": KEY_APP_B, "org_id": ORG_ID, "name": "batch-agent"},
    ]
    client.tables["gateway_usage_events"] = [
        _event_row(
            request_id="req-1",
            api_key_id=KEY_PROD,
            alias="haiku",
            provider="anthropic",
            input_tokens=100,
            output_tokens=200,
            reasoning_tokens=10,
            cached_input_tokens=40,
            generation_duration_ms=2000,
            routing_overhead_ms=100,
            latency_ms=2200,
            cost_micro_usd=3000,
            created_at="2026-08-19T10:05:00+00:00",
        ),
        _event_row(
            request_id="req-2",
            api_key_id=KEY_PROD,
            alias="haiku",
            provider="anthropic",
            input_tokens=100,
            output_tokens=200,
            reasoning_tokens=10,
            cached_input_tokens=60,
            generation_duration_ms=2000,
            routing_overhead_ms=300,
            latency_ms=2500,
            cost_micro_usd=3000,
            created_at="2026-08-19T10:20:00+00:00",
        ),
        # Pre-dispatch failure: null provider and null durations. Must not enter
        # any rate/duration aggregate or the tok/s series.
        _event_row(
            request_id="req-3",
            api_key_id=KEY_APP_B,
            alias="sonnet",
            provider=None,
            lane=None,
            input_tokens=50,
            output_tokens=0,
            reasoning_tokens=0,
            cached_input_tokens=0,
            generation_duration_ms=None,
            routing_overhead_ms=None,
            latency_ms=None,
            status="expired_before_dispatch",
            attempt_count=0,
            cost_micro_usd=0,
            created_at="2026-08-19T10:40:00+00:00",
        ),
        _event_row(
            request_id="req-4",
            api_key_id=KEY_APP_B,
            alias="sonnet",
            provider="openai",
            lane="pass_through",
            input_tokens=200,
            output_tokens=600,
            reasoning_tokens=50,
            cached_input_tokens=100,
            generation_duration_ms=3000,
            routing_overhead_ms=200,
            latency_ms=3300,
            cost_micro_usd=0,
            estimated_cost_micro_usd=9000,
            created_at="2026-08-19T11:05:00+00:00",
        ),
        # Attribution snapshot for a key with no api_keys row (deleted after use).
        _event_row(
            request_id="req-5",
            api_key_id="11111111-0000-4000-8000-0000000000ff",
            alias="haiku",
            provider="anthropic",
            input_tokens=10,
            output_tokens=20,
            reasoning_tokens=1,
            cached_input_tokens=5,
            generation_duration_ms=500,
            routing_overhead_ms=50,
            latency_ms=600,
            cost_micro_usd=500,
            created_at="2026-08-19T12:05:00+00:00",
        ),
    ]
    return GatewayUsageStore(cast("SupabaseClient", client))


def _cell(rows: tuple[GatewayInsightsMetricRow, ...], key: str) -> GatewayInsightsMetricRow:
    return next(row for row in rows if row.bucket_key == key)


def test_insights_metrics_by_model_cache_hit_and_throughput() -> None:
    """Model grouping yields cache-hit rate, aggregate tok/s, and reasoning."""
    rows = _insights_store().insights_metrics(ORG_ID, group_by=GatewayInsightsGroupBy.MODEL)
    haiku = _cell(rows, "haiku")
    assert haiku.request_count == 3
    assert haiku.completed_count == 3
    assert haiku.reasoning_tokens == 21
    assert haiku.cache_hit_rate == 105 / 210
    # 420 completion tokens over 4.5 generation seconds.
    assert haiku.tokens_per_second == 420 / 4.5


def test_insights_metrics_ignores_pre_dispatch_failure_in_rates() -> None:
    """A pre-dispatch failure is counted but never enters the tok/s denominator."""
    rows = _insights_store().insights_metrics(ORG_ID, group_by=GatewayInsightsGroupBy.MODEL)
    sonnet = _cell(rows, "sonnet")
    assert sonnet.request_count == 2
    assert sonnet.error_count == 1
    assert sonnet.tokens_per_second == 600 / 3
    assert sonnet.avg_generation_duration_ms == 3000


def test_insights_metrics_provider_bucketizes_no_dispatch() -> None:
    """Requests that never dispatched fall in the no-dispatch provider bucket."""
    rows = _insights_store().insights_metrics(ORG_ID, group_by=GatewayInsightsGroupBy.PROVIDER)
    keys = {row.bucket_key for row in rows}
    assert keys == {"anthropic", "openai", "(no dispatch)"}
    assert _cell(rows, "(no dispatch)").request_count == 1


def test_insights_tokens_per_second_series_and_alias_filter() -> None:
    """The series buckets dispatched hours and the alias filter narrows it."""
    store = _insights_store()
    series = store.insights_tokens_per_second(ORG_ID, bucket_seconds=3600)
    assert isinstance(series[0], GatewayTokensPerSecondRow)
    ten = next(p for p in series if p.bucket_start.startswith("2026-08-19T10:00:00"))
    assert ten.request_count == 2
    assert ten.completion_tokens == 400
    assert ten.tokens_per_second == 400 / 4
    # The expired request contributes no bucket -> three dispatched hours only.
    assert len(series) == 3
    only_sonnet = store.insights_tokens_per_second(ORG_ID, bucket_seconds=3600, alias="sonnet")
    assert len(only_sonnet) == 1
    assert only_sonnet[0].tokens_per_second == 600 / 3


def test_insights_top_apps_ranks_keys_and_keeps_deleted_history() -> None:
    """Top apps ranks by traffic, labels live keys, and null-labels deleted ones."""
    rows = _insights_store().insights_top_apps(ORG_ID)
    assert len(rows) == 3
    by_id = {row.api_key_id: row for row in rows}
    assert by_id[KEY_PROD].app_label == "prod-agent"
    assert by_id[KEY_PROD].request_count == 2
    assert by_id[KEY_PROD].reasoning_tokens == 20
    deleted = by_id["11111111-0000-4000-8000-0000000000ff"]
    assert deleted.app_label is None
    assert isinstance(deleted, GatewayTopAppRow)


def test_by_prompt_rolls_up_lineage_groups_and_skips_pre_lineage_rows() -> None:
    """One row per (prompt digest, alias); rows without lineage never appear."""
    store, client = _store()
    prompt_a = "ab12" * 16
    prompt_b = "cd34" * 16
    client.tables["gateway_usage_events"] = [
        _event_row(
            request_id="req-1",
            prompt_sha256=prompt_a,
            conversation_sha256="11" * 32,
            stable_prefix_chars=8_000,
        ),
        _event_row(
            request_id="req-2",
            prompt_sha256=prompt_a,
            conversation_sha256="22" * 32,
            stable_prefix_chars=8_000,
            status="failed",
            cached_input_tokens=40,
        ),
        _event_row(request_id="req-3", prompt_sha256=prompt_b, conversation_sha256="33" * 32),
        # Settled before lineage existed: excluded from the rollup.
        _event_row(request_id="req-4"),
    ]
    rows = store.usage_by_prompt(ORG_ID)
    assert [row.prompt_sha256 for row in rows] == [prompt_a, prompt_b]
    group = rows[0]
    assert group.request_count == 2
    assert group.error_count == 1
    assert group.conversation_count == 2
    assert group.agent_count == 1
    assert group.input_tokens == 200
    assert group.cached_input_tokens == 40
    assert group.stable_prefix_chars == 8_000


def test_usage_by_prompt_serves_repeat_calls_from_cache() -> None:
    """The per-prompt rollup rides the same short-TTL aggregate cache."""
    client = _CountingClient()
    store = GatewayUsageStore(cast("SupabaseClient", client))
    store.usage_by_prompt(ORG_ID, after="2026-08-01T00:00:00+00:00")
    store.usage_by_prompt(ORG_ID, after="2026-08-01T00:00:00+00:00")
    assert len(client.rpc_calls) == 1
