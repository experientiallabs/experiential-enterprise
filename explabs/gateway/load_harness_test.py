# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for the load harness: math, parsing, and the loopback provider."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from explabs.gateway.load_harness import (
    LoadProfile,
    LoadReport,
    LoopbackProvider,
    Percentiles,
    _shard_concurrency,
    parse_server_timing,
    report_from_outcomes,
    run_load,
    run_load_processes,
)


def test_percentiles_pin_rank_semantics() -> None:
    """Nearest-rank percentiles over a known distribution."""
    stats = Percentiles.of([float(value) for value in range(1, 101)])
    assert stats.count == 100
    assert stats.p50 == 50.0
    assert stats.p90 == 90.0
    assert stats.p99 == 99.0
    assert stats.p999 == 100.0
    assert stats.minimum == 1.0
    assert stats.maximum == 100.0


def test_percentiles_single_sample_and_empty() -> None:
    """One sample answers every quantile; zero samples is an error."""
    stats = Percentiles.of([42.0])
    assert stats.p50 == stats.p999 == 42.0
    with pytest.raises(ValueError, match="at least one sample"):
        Percentiles.of([])


def test_parse_server_timing_full_and_partial() -> None:
    """The platform's exact header shape parses; junk degrades to None."""
    parsed = parse_server_timing('app;dur=12.3, db;dur=4.5;desc="3q", dbwait;dur=0.1')
    assert parsed is not None
    assert parsed.app_ms == 12.3
    assert parsed.db_ms == 4.5
    assert parsed.db_calls == 3
    assert parsed.db_wait_ms == 0.1

    assert parse_server_timing(None) is None
    assert parse_server_timing("") is None
    assert parse_server_timing("cache;desc=hit") is None

    partial = parse_server_timing("app;dur=7")
    assert partial is not None
    assert partial.app_ms == 7.0
    assert partial.db_calls is None


def test_loopback_provider_serves_deterministic_sse_and_counts() -> None:
    """The provider streams the fixed frames, counts calls, retains nothing."""
    provider = LoopbackProvider()
    provider.start()
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.post(
                f"{provider.base_url}/chat/completions",
                json={"model": "m", "messages": [], "stream": True},
            )
        assert response.status_code == 200
        body = response.text
        assert body.count("data: ") == 5
        assert body.rstrip().endswith("data: [DONE]")
        usage_frame = next(
            json.loads(line[len("data: ") :])
            for line in body.splitlines()
            if line.startswith("data: {") and "usage" in line
        )
        assert usage_frame["usage"] == {"prompt_tokens": 8, "completion_tokens": 4}
        assert provider.calls == 1
    finally:
        provider.stop()


def test_run_load_reports_steady_state_against_the_provider() -> None:
    """A short closed-loop run against the raw provider yields a sane report.

    Driving the provider directly (no gateway) pins the driver mechanics:
    warmup discard, throughput accounting, all-200 taxonomy, and the
    provider-floor sample the added-latency subtraction depends on.
    """
    provider = LoopbackProvider()
    provider.start()
    try:
        report = asyncio.run(
            run_load(
                target_name="provider-floor",
                # The provider itself is OpenAI-shaped, so its /v1 base works.
                base_url=provider.base_url,
                api_key="xpl_unused_by_the_raw_provider",
                model="loopback",
                profile=LoadProfile(concurrency=4, duration_seconds=1.0, warmup_seconds=0.3),
            )
        )
    finally:
        provider.stop()
    assert report.completed > 0
    assert report.throughput_rps > 0
    assert set(report.outcomes_by_status) == {"200"}
    assert report.ttfb.p50 <= report.total.p50 <= report.total.maximum
    assert report.db_calls_per_request is None  # the raw provider emits no Server-Timing
    assert report.db_ms is None
    assert report.db_wait_ms is None
    parsed = json.loads(report.to_json())
    assert parsed["target"] == "provider-floor"
    assert parsed["outcomes_by_status"] == {"200": report.completed}
    assert parsed["db_ms"] is None
    assert parsed["db_wait_ms"] is None


def test_shard_concurrency_sums_and_drops_empty_shards() -> None:
    """Shards are near-even, sum to the total, and never include zeros."""
    assert _shard_concurrency(64, 8) == [8] * 8
    assert _shard_concurrency(10, 4) == [3, 3, 2, 2]
    # Fewer clients than processes: the empty shards are dropped, not run.
    assert _shard_concurrency(2, 4) == [1, 1]
    assert sum(_shard_concurrency(257, 8)) == 257
    with pytest.raises(ValueError, match="at least 1"):
        _shard_concurrency(0, 4)
    with pytest.raises(ValueError, match="at least 1"):
        _shard_concurrency(4, 0)


def test_report_from_outcomes_requires_steady_samples() -> None:
    """Zero steady-state samples is the same loud error the driver raises."""
    with pytest.raises(RuntimeError, match="no steady-state samples"):
        report_from_outcomes(
            target_name="empty",
            profile=LoadProfile(concurrency=1, duration_seconds=1.0),
            steady=[],
            provider_calls=0,
        )


def test_run_load_processes_merges_shards_against_the_provider() -> None:
    """Two client processes yield one merged steady-state report.

    Mirrors the in-process driver test but crosses the process boundary:
    outcomes pickle back, the merged report spans both shards, and the
    provider dispatch delta is counted in the parent.
    """
    provider = LoopbackProvider()
    provider.start()
    try:
        report = run_load_processes(
            target_name="provider-floor-mp",
            base_url=provider.base_url,
            api_key="xpl_unused_by_the_raw_provider",
            model="loopback",
            profile=LoadProfile(concurrency=4, duration_seconds=1.0, warmup_seconds=0.3),
            processes=2,
            provider=provider,
        )
    finally:
        provider.stop()
    assert report.completed > 0
    assert report.throughput_rps > 0
    assert set(report.outcomes_by_status) == {"200"}
    assert report.provider_calls >= report.completed
    parsed = json.loads(report.to_json())
    assert parsed["concurrency"] == 4


def test_run_load_processes_single_process_degrades_to_run_load() -> None:
    """processes=1 keeps the exact in-process driver (no pool, no spawn)."""
    provider = LoopbackProvider()
    provider.start()
    try:
        report = run_load_processes(
            target_name="provider-floor-single",
            base_url=provider.base_url,
            api_key="xpl_unused_by_the_raw_provider",
            model="loopback",
            profile=LoadProfile(concurrency=2, duration_seconds=0.8, warmup_seconds=0.2),
            processes=1,
            provider=provider,
        )
    finally:
        provider.stop()
    assert report.completed > 0
    assert set(report.outcomes_by_status) == {"200"}


def test_report_serializes_db_attribution_when_present() -> None:
    """A report carrying Server-Timing distributions emits them rounded."""
    stats = Percentiles.of([1.234, 2.345, 3.456])
    report = LoadReport(
        target="worker",
        profile=LoadProfile(concurrency=1, duration_seconds=1.0),
        completed=3,
        throughput_rps=3.0,
        ttfb=stats,
        total=stats,
        outcomes_by_status={"200": 3},
        db_calls_per_request=2.0,
        provider_calls=3,
        db_ms=stats,
        db_wait_ms=stats,
    )
    parsed = json.loads(report.to_json())
    assert parsed["db_ms"] == {"p50": 2.35, "p90": 3.46, "p99": 3.46, "max": 3.46}
    assert parsed["db_wait_ms"]["p50"] == 2.35


def test_loopback_provider_fault_injection_modes() -> None:
    """ProviderFault drives status errors, every_nth flakiness, and resets."""
    from explabs.gateway.load_harness import ProviderFault

    # A 500 fault on every call.
    provider = LoopbackProvider(fault=ProviderFault(status=500))
    provider.start()
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.post(
                f"{provider.base_url}/chat/completions", json={"model": "m", "messages": []}
            )
        assert response.status_code == 500
        assert response.json()["error"]["type"] == "server_error"
    finally:
        provider.stop()

    # every_nth=2: odd calls healthy, even calls faulted.
    flaky = LoopbackProvider(fault=ProviderFault(status=503, every_nth=2))
    flaky.start()
    try:
        with httpx.Client(timeout=10.0) as client:
            first = client.post(
                f"{flaky.base_url}/chat/completions", json={"model": "m", "messages": []}
            )
            second = client.post(
                f"{flaky.base_url}/chat/completions", json={"model": "m", "messages": []}
            )
        assert first.status_code == 200
        assert second.status_code == 503
    finally:
        flaky.stop()


def test_loopback_provider_partial_then_reset_truncates_the_stream() -> None:
    """partial_then_reset yields the first frame then drops without [DONE]."""
    from explabs.gateway.load_harness import ProviderFault

    provider = LoopbackProvider(fault=ProviderFault(partial_then_reset=True))
    provider.start()
    try:
        # The stream truncates mid-flight: the client reads the first frame,
        # then the peer drops without a terminal chunk, which surfaces as a
        # RemoteProtocolError -- exactly the mid-stream provider death this
        # fault emulates.
        collected = _read_until_truncated(provider.base_url)
        assert "load " in collected
        assert "[DONE]" not in collected
    finally:
        provider.stop()


def _read_until_truncated(base_url: str) -> str:
    """Read a stream that the provider drops mid-flight; return what arrived."""
    collected = ""

    def _drain(client: httpx.Client) -> None:
        nonlocal collected
        with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            json={"model": "m", "messages": [], "stream": True},
        ) as response:
            for chunk in response.iter_raw():
                collected += chunk.decode()

    with httpx.Client(timeout=10.0) as client, pytest.raises(httpx.RemoteProtocolError):
        _drain(client)
    return collected
