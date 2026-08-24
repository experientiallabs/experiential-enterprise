# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for per-request database query timing."""

from __future__ import annotations

import asyncio

from explabs.db import query_timing


def test_record_without_scope_is_a_no_op() -> None:
    """Queries issued outside any recording scope must not raise or leak."""
    query_timing.record_query(lock_wait_ms=1.0, execute_ms=2.0)


def test_recording_scope_accumulates_calls() -> None:
    """Recorded queries sum into the scope opened by begin_recording."""
    stats = query_timing.begin_recording()
    query_timing.record_query(lock_wait_ms=1.5, execute_ms=80.0)
    query_timing.record_query(lock_wait_ms=0.5, execute_ms=20.0)
    assert stats.calls == 2
    assert stats.execute_ms == 100.0
    assert stats.lock_wait_ms == 2.0


def test_record_lock_wait_adds_wait_without_counting_a_call() -> None:
    """A per-transaction pool-checkout wait lands in lock_wait_ms alone."""
    stats = query_timing.begin_recording()
    query_timing.record_lock_wait(5.0)
    assert stats.calls == 0
    assert stats.execute_ms == 0.0
    assert stats.lock_wait_ms == 5.0


def test_scope_propagates_into_to_thread_work() -> None:
    """A request's thread-pool store calls land in that request's scope."""

    async def request() -> query_timing.QueryStats:
        stats = query_timing.begin_recording()
        await asyncio.to_thread(query_timing.record_query, lock_wait_ms=0.0, execute_ms=42.0)
        return stats

    stats = asyncio.run(request())
    assert stats.calls == 1
    assert stats.execute_ms == 42.0


def test_new_scope_replaces_the_previous_one() -> None:
    """begin_recording starts from zero instead of extending an old scope."""
    first = query_timing.begin_recording()
    second = query_timing.begin_recording()
    query_timing.record_query(lock_wait_ms=0.0, execute_ms=10.0)
    assert first.calls == 0
    assert second.calls == 1
