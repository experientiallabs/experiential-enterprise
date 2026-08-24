# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Direct sync Postgres connection pool for the gateway worker hot path."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Self

from psycopg import Connection, Cursor
from psycopg.abc import Params, Query, Template
from psycopg.rows import TupleRow
from psycopg_pool import ConnectionPool

from explabs.db import query_timing

# Every pooled connect is bounded so a pool opened against an unreachable
# database (the in-cluster "can't reach Supabase" case) fails in seconds with
# the psycopg error logged, instead of hanging the worker's startup path before
# uvicorn binds. Kept in the same seconds range as the readiness ping.
_POOL_CONNECT_TIMEOUT_SECONDS = 10


def _reset_pooled_connection(connection: Connection[TupleRow]) -> None:
    """Normalize a returned connection back to the transactional default.

    The pool already rolls back any open transaction before this runs, so the
    only extra work here is turning ``autocommit`` back off: a connection the
    money fast path borrowed in autocommit mode (see ``atomic_call``) must be
    handed back with the transactional default, or the mode would leak into a
    later ``transaction()`` checkout and silently drop its multi-statement
    rollback. Setting the flag while the connection is IDLE costs no round trip.
    """
    if connection.autocommit:
        connection.autocommit = False


class _TimedCursor(Cursor[TupleRow]):
    """Cursor recording each executed statement into the request query scope.

    Statements issued by the worker's background threads (heartbeat,
    reconcile, catalog) run with no active recording scope and are dropped by
    the accumulator, so only request-scoped work is attributed.
    """

    def execute(
        self,
        query: Query,
        params: Params | None = None,
        *,
        prepare: bool | None = None,
        binary: bool | None = None,
    ) -> Self:
        """Execute one statement, recording its wall time as one logical call."""
        started = time.perf_counter()
        try:
            # The base overloads split template from non-template queries;
            # the worker's adapters only ever pass plain SQL with bound
            # params, but the override must stay substitutable.
            if isinstance(query, Template):
                if params is not None:
                    msg = "template queries take no params"
                    raise TypeError(msg)
                return super().execute(query, prepare=prepare, binary=binary)
            return super().execute(query, params, prepare=prepare, binary=binary)
        finally:
            query_timing.record_query(
                lock_wait_ms=0.0,
                execute_ms=(time.perf_counter() - started) * 1000.0,
            )


class GatewayDatabase:
    """One sync psycopg pool whose every checkout is exactly one transaction.

    The gateway worker's storage adapters call the ``gateway_*`` security
    definer SQL functions through this pool (``SUPABASE_DB_URL``), so the
    transaction boundary always lives inside Postgres. The pool opens lazily on
    first use so constructing an adapter never blocks on the network.

    Two checkout shapes share the one pool: ``transaction()`` for genuine
    multi-statement atomic work (commit on success, rollback on failure), and
    ``atomic_call()`` for a single self-atomic function call, which runs in
    autocommit and so commits in one round trip instead of paying a separate
    ``COMMIT`` exchange.
    """

    def __init__(self, dsn: str, *, min_size: int = 2, max_size: int = 10) -> None:
        """Configure one worker-local pool without connecting yet.

        Args:
            dsn: PostgreSQL connection URL (``SUPABASE_DB_URL``).
            min_size: Connections kept warm per worker.
            max_size: Hard per-worker connection bound.
        """
        self._pool = ConnectionPool(
            dsn,
            min_size=min_size,
            max_size=max_size,
            open=False,
            kwargs={"connect_timeout": _POOL_CONNECT_TIMEOUT_SECONDS},
            reset=_reset_pooled_connection,
        )
        self._open_lock = threading.Lock()
        self._opened = False

    @contextmanager
    def transaction(self) -> Iterator[Cursor[TupleRow]]:
        """Run one transaction: commit on success, roll back on any failure.

        Yields:
            A cursor bound to one pooled connection for the transaction's life.
        """
        self._ensure_open()
        checkout_started = time.perf_counter()
        with self._pool.connection() as connection:
            # Checkout wait is serialization behind other requests' work: the
            # psycopg analog of the PostgREST client's execute-lock wait.
            query_timing.record_lock_wait((time.perf_counter() - checkout_started) * 1000.0)
            with _TimedCursor(connection) as cursor:
                yield cursor

    @contextmanager
    def atomic_call(self) -> Iterator[Cursor[TupleRow]]:
        """Run one self-atomic statement, committed in a single round trip.

        The checked-out connection is switched to autocommit, so the statement
        commits as it executes with no separate ``COMMIT`` exchange. Every
        ``gateway_*`` security-definer function is atomic on its own, so this is
        exactly equivalent to ``transaction()`` for a SINGLE such call while
        saving the money hot path one round trip per reserve/settle. It is
        correct ONLY for a single statement whose atomicity is the SQL
        function's own; genuine multi-statement atomic work must use
        ``transaction()``. The pool's reset (``_reset_pooled_connection``)
        restores ``autocommit=False`` on return, so the mode never leaks.

        Yields:
            A cursor bound to one autocommit connection for the call's life.
        """
        self._ensure_open()
        checkout_started = time.perf_counter()
        with self._pool.connection() as connection:
            query_timing.record_lock_wait((time.perf_counter() - checkout_started) * 1000.0)
            # Safe to set while IDLE (a freshly reset checkout); the statement
            # then commits inline and the connection stays IDLE afterward, so
            # the pool's IDLE-on-return invariant holds.
            connection.autocommit = True
            with _TimedCursor(connection) as cursor:
                yield cursor

    def close(self) -> None:
        """Close every pooled connection."""
        with self._open_lock:
            if self._opened:
                self._pool.close()
                self._opened = False

    def _ensure_open(self) -> None:
        """Open the pool exactly once, on first use."""
        if self._opened:
            return
        with self._open_lock:
            if not self._opened:
                self._pool.open()
                self._opened = True
