# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for observed catalog stats computed from the usage ledger."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from explabs.api.routes.model_stats import (
    MIN_OBSERVED_SAMPLE,
    OBSERVED_WINDOW,
    ObservedModelStat,
    fetch_observed_stats,
    overlay_deployment_row,
)
from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload

_NOW = datetime(2026, 8, 21, tzinfo=UTC)


def _event_row(index: int, **overrides: object) -> JsonObject:
    row: JsonObject = {
        "request_id": f"req-{index}",
        "alias": "kimi",
        "provider": "openrouter",
        "status": "completed",
        "output_tokens": 50,
        "latency_ms": 1000,
        "created_at": (_NOW - timedelta(days=1)).isoformat(),
    }
    row.update(overrides)
    return row


def _seed(client: FakeSupabaseClient, rows: list[JsonObject]) -> None:
    client.tables["gateway_usage_events"] = rows


def test_fetch_aggregates_throughput_uptime_and_latency() -> None:
    """A route past the sample floor gets p50 tok/s, uptime, and p50 latency."""
    client = FakeSupabaseClient()
    # 18 identical completed events (50 tok/s, 1000 ms each) + 2 failures = 20
    # terminal events, so uptime is 90% and both p50s are exact.
    _seed(
        client,
        [_event_row(index) for index in range(18)]
        + [
            _event_row(18 + index, status="failed", output_tokens=0, latency_ms=None)
            for index in range(2)
        ],
    )

    stats = fetch_observed_stats(client, now=_NOW)

    assert stats == {
        ("kimi", "openrouter"): ObservedModelStat(
            throughput_tps=50.0,
            uptime_30d=90.0,
            latency_p50_ms=1000.0,
            sample_count=20,
        )
    }


def test_fetch_drops_routes_below_sample_floor_and_unattributed_events() -> None:
    """Quiet routes and events with no winning provider never surface."""
    client = FakeSupabaseClient()
    _seed(
        client,
        [_event_row(index) for index in range(MIN_OBSERVED_SAMPLE - 1)]
        + [_event_row(100 + index, provider=None) for index in range(MIN_OBSERVED_SAMPLE)],
    )

    assert fetch_observed_stats(client, now=_NOW) == {}


def test_fetch_reports_uptime_without_throughput_when_unmeasured() -> None:
    """Completed events lacking a duration yield uptime but no p50s."""
    client = FakeSupabaseClient()
    _seed(
        client,
        [
            _event_row(index, output_tokens=100, latency_ms=None)
            for index in range(MIN_OBSERVED_SAMPLE)
        ],
    )

    stat = fetch_observed_stats(client, now=_NOW)[("kimi", "openrouter")]

    assert stat.uptime_30d == 100.0
    assert stat.throughput_tps is None
    assert stat.latency_p50_ms is None
    assert stat.sample_count == MIN_OBSERVED_SAMPLE


def test_fetch_windows_the_ledger() -> None:
    """The aggregate covers only events inside the trailing window."""
    client = FakeSupabaseClient()
    stale = (_NOW - OBSERVED_WINDOW - timedelta(days=1)).isoformat()
    _seed(
        client,
        [_event_row(index, output_tokens=60) for index in range(MIN_OBSERVED_SAMPLE)]
        # A stale failure for the same route must be excluded by the window
        # bound; if it counted, sample_count would be 21 and uptime below 100.
        + [_event_row(999, status="failed", output_tokens=0, latency_ms=None, created_at=stale)],
    )

    stat = fetch_observed_stats(client, now=_NOW)[("kimi", "openrouter")]

    assert stat.sample_count == MIN_OBSERVED_SAMPLE
    assert stat.uptime_30d == 100.0
    assert stat.throughput_tps == 60.0


def test_fetch_is_one_rpc_and_never_reads_rows() -> None:
    """One aggregate query per fetch — never a row-level read or offset walk.

    Regression pin for the 2026-08-22 capacity incident: the previous
    implementation offset-walked the whole 30-day cross-org window through
    PostgREST table reads and accumulated every row in memory, from anonymous
    storefront traffic. The fetch must issue exactly one RPC and touch no
    table, regardless of window size.
    """

    class _CountingClient(FakeSupabaseClient):
        def __init__(self) -> None:
            super().__init__()
            self.rpc_calls: list[str] = []
            self.table_reads: list[str] = []

        def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
            self.rpc_calls.append(fn)
            return super().rpc(fn, params)

        def table(self, table_name: str) -> FakeQuery:
            self.table_reads.append(table_name)
            return super().table(table_name)

    client = _CountingClient()
    _seed(client, [_event_row(index) for index in range(5 * MIN_OBSERVED_SAMPLE)])

    fetch_observed_stats(client, now=_NOW)

    assert client.rpc_calls == ["gateway_observed_model_stats"]
    assert client.table_reads == []


def test_overlay_deployment_row_applies_observed_stats() -> None:
    """A matched route overrides the seeded stats and stamps the source."""
    row: JsonObject = {
        "id": "dep-1",
        "provider": "openrouter",
        "uptime_30d": 99.9,
        "throughput_tps": None,
        "latency_p50_ms": None,
        "stats_source": "openrouter",
    }
    stats = {
        ("kimi", "openrouter"): ObservedModelStat(
            throughput_tps=42.0, uptime_30d=88.0, latency_p50_ms=1200.0, sample_count=25
        )
    }

    overlaid = overlay_deployment_row(row, "kimi", stats)

    assert overlaid["uptime_30d"] == 88.0
    assert overlaid["throughput_tps"] == 42.0
    assert overlaid["latency_p50_ms"] == 1200.0
    assert overlaid["stats_source"] == "observed"
    # The input row is not mutated in place.
    assert row["stats_source"] == "openrouter"


def test_overlay_deployment_row_keeps_row_without_observed_data() -> None:
    """An unmatched route keeps its seeded values untouched."""
    row: JsonObject = {
        "id": "dep-1",
        "provider": "anthropic",
        "uptime_30d": 99.9,
        "throughput_tps": None,
        "stats_source": "openrouter",
    }

    assert overlay_deployment_row(row, "kimi", {}) is row
