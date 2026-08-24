# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the gateway worker's pooled transaction boundary."""

from __future__ import annotations

import threading
import uuid
from typing import cast

import pytest
from psycopg import Connection
from psycopg.rows import TupleRow

from explabs.db import query_timing
from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.db import (
    _POOL_CONNECT_TIMEOUT_SECONDS,
    GatewayDatabase,
    _reset_pooled_connection,
)


def test_construction_never_connects() -> None:
    """Adapters must be constructible before any network is reachable."""
    db = GatewayDatabase("postgresql://nobody@127.0.0.1:1/nowhere", min_size=1, max_size=1)
    db.close()


def test_pool_bounds_the_connect_timeout() -> None:
    """A pool opened against an unreachable DB must fail in seconds, not hang.

    The worker's startup path (the presence heartbeat) opens the pool before
    uvicorn binds; without a bounded connect timeout an unreachable Supabase
    hangs startup and starves the readiness probe.
    """
    db = GatewayDatabase("postgresql://nobody@127.0.0.1:1/nowhere", min_size=1, max_size=1)
    try:
        pool_kwargs = cast("dict[str, object]", db._pool.kwargs)  # noqa: SLF001
        assert pool_kwargs["connect_timeout"] == _POOL_CONNECT_TIMEOUT_SECONDS
        assert _POOL_CONNECT_TIMEOUT_SECONDS > 0
    finally:
        db.close()


class _AutocommitStub:
    """Minimal connection carrying just the ``autocommit`` flag under test."""

    def __init__(self, *, autocommit: bool) -> None:
        self.autocommit = autocommit


def test_reset_turns_a_borrowed_autocommit_connection_back_off() -> None:
    """A connection the fast path left in autocommit is normalized on return."""
    conn = _AutocommitStub(autocommit=True)
    _reset_pooled_connection(cast("Connection[TupleRow]", conn))
    assert conn.autocommit is False


def test_reset_leaves_a_transactional_connection_untouched() -> None:
    """The common transactional return needs no change (no wasted write)."""
    conn = _AutocommitStub(autocommit=False)
    _reset_pooled_connection(cast("Connection[TupleRow]", conn))
    assert conn.autocommit is False


@pytest.mark.integration
def test_atomic_call_persists_a_single_statement_without_an_explicit_commit(
    gateway_db: GatewayDatabase, gateway_harness: GatewayHarness
) -> None:
    """The autocommit fast path commits its one statement inline, no COMMIT hop."""
    org_id = str(uuid.uuid4())
    with gateway_db.atomic_call() as cursor:
        cursor.execute(
            """
            insert into public.organizations (id, slug, name)
            values (%s, %s, 'Gateway Atomic Call')
            """,
            (org_id, f"gw-int-ac-{org_id[:13]}"),
        )
    # No explicit commit ran, yet the row is durable: autocommit committed it.
    row = gateway_harness.fetch_one("select 1 from public.organizations where id = %s", (org_id,))
    assert row == (1,)


@pytest.mark.integration
def test_atomic_call_does_not_leak_autocommit_into_the_next_transaction(
    gateway_db: GatewayDatabase, gateway_harness: GatewayHarness
) -> None:
    """After a fast-path checkout, transaction() still rolls back on failure."""
    with gateway_db.atomic_call() as cursor:
        cursor.execute("select 1")
    org_id = str(uuid.uuid4())

    def insert_then_fail() -> None:
        """Insert one row inside a transaction and abort it."""
        failure = RuntimeError("after insert")
        with gateway_db.transaction() as cursor:
            cursor.execute(
                """
                insert into public.organizations (id, slug, name)
                values (%s, %s, 'Gateway Leak Guard')
                """,
                (org_id, f"gw-int-lk-{org_id[:13]}"),
            )
            raise failure

    with pytest.raises(RuntimeError, match="after insert"):
        insert_then_fail()
    row = gateway_harness.fetch_one("select 1 from public.organizations where id = %s", (org_id,))
    assert row is None


@pytest.mark.integration
def test_atomic_call_statements_record_into_the_active_query_scope(
    gateway_db: GatewayDatabase,
) -> None:
    """Fast-path statements attribute to the request scope like transaction()."""
    stats = query_timing.begin_recording()
    with gateway_db.atomic_call() as cursor:
        cursor.execute("select 1")
    assert stats.calls == 1
    assert stats.execute_ms > 0.0


@pytest.mark.integration
def test_transaction_commits_on_success_and_rolls_back_on_failure(
    gateway_db: GatewayDatabase, gateway_harness: GatewayHarness
) -> None:
    """One pool checkout is exactly one transaction."""
    org_id = str(uuid.uuid4())

    def insert_then_fail() -> None:
        """Insert one row and abort the same transaction."""
        failure = RuntimeError("after insert")
        with gateway_db.transaction() as cursor:
            cursor.execute(
                """
                insert into public.organizations (id, slug, name)
                values (%s, %s, 'Gateway P2 Rollback')
                """,
                (org_id, f"gw-int-rb-{org_id[:13]}"),
            )
            raise failure

    with pytest.raises(RuntimeError, match="after insert"):
        insert_then_fail()
    row = gateway_harness.fetch_one("select 1 from public.organizations where id = %s", (org_id,))
    assert row is None

    with gateway_db.transaction() as cursor:
        cursor.execute("select 1")
        fetched = cursor.fetchone()
    assert fetched == (1,)


@pytest.mark.integration
def test_transaction_statements_record_into_the_active_query_scope(
    gateway_db: GatewayDatabase,
) -> None:
    """Each executed statement counts once toward the request's query scope."""
    stats = query_timing.begin_recording()
    with gateway_db.transaction() as cursor:
        cursor.execute("select 1")
        cursor.execute("select 2")
    assert stats.calls == 2
    assert stats.execute_ms > 0.0


@pytest.mark.integration
def test_background_thread_statements_stay_out_of_the_request_scope(
    gateway_db: GatewayDatabase,
) -> None:
    """Heartbeat-style threads start with a fresh context and record nothing."""
    stats = query_timing.begin_recording()

    def background() -> None:
        """Run one transaction the way the worker's background loops do."""
        with gateway_db.transaction() as cursor:
            cursor.execute("select 1")

    worker = threading.Thread(target=background)
    worker.start()
    worker.join(timeout=10)
    assert not worker.is_alive()
    assert stats.calls == 0
    assert stats.lock_wait_ms == 0.0
