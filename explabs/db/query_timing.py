# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Per-request database query timing.

Two database paths record here. The PostgREST client (``explabs.db.client``)
records how long each exchange spends waiting for the client's execute lock
and then executing on the wire; the gateway worker's psycopg pool
(``explabs.gateway.db``) records each executed statement plus its
connection-checkout wait. The request-timing middleware opens a recording
scope per request and reads the totals back for its Server-Timing header and
request log line. The accumulator lives here, below both layers, so neither
database module ever imports the API package.

Recording is context-local: a scope set by the middleware propagates into the
thread-pool work FastAPI schedules for that request (contextvars are copied at
submission), so store calls made from sync handlers and ``asyncio.to_thread``
land in the right request's totals. Queries issued with no active scope (boot,
reapers, background builds, the gateway worker's heartbeat/reconcile/catalog
threads) are not recorded.
"""

from __future__ import annotations

import threading
from contextvars import ContextVar
from dataclasses import dataclass, field


@dataclass
class QueryStats:
    """Mutable accumulator of one request's database call timings.

    Attributes:
        calls: Number of logical store calls executed. Transport retries are
            deliberately not counted as extra calls: the metric attributes how
            many queries a route issues, so a stale-connection retry shows up
            as ballooned ``execute_ms`` on one call, not as a phantom query.
        execute_ms: Total wall-clock milliseconds spent executing on the wire,
            including any in-lock retry backoff and re-sends.
        lock_wait_ms: Total milliseconds spent waiting to acquire the
            PostgREST client's execute lock or a pooled psycopg connection,
            i.e. serialization behind other requests' queries.

    Updates take a lock: one request's store calls can run on several worker
    threads at once (the client pool makes exchanges genuinely concurrent),
    and an unguarded float ``+=`` is a read-modify-write that loses updates.
    """

    calls: int = 0
    execute_ms: float = 0.0
    lock_wait_ms: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


_active_stats: ContextVar[QueryStats | None] = ContextVar(
    "explabs_active_query_stats", default=None
)


def begin_recording() -> QueryStats:
    """Open a fresh recording scope for the current context.

    Returns:
        The live accumulator; the caller reads it after the request finishes.
    """
    stats = QueryStats()
    _active_stats.set(stats)
    return stats


def record_query(*, lock_wait_ms: float, execute_ms: float) -> None:
    """Record one database exchange into the active scope, if any.

    Args:
        lock_wait_ms: Milliseconds spent waiting for the execute lock.
        execute_ms: Milliseconds spent executing while holding the lock.
    """
    stats = _active_stats.get()
    if stats is None:
        return
    with stats._lock:  # noqa: SLF001 - the accumulator's own lock
        stats.calls += 1
        stats.execute_ms += execute_ms
        stats.lock_wait_ms += lock_wait_ms


def record_lock_wait(lock_wait_ms: float) -> None:
    """Record wait time into the active scope without counting a call.

    The gateway worker waits for a pooled connection once per transaction,
    not once per statement, so that wait lands in ``lock_wait_ms`` alone and
    ``calls`` keeps meaning "statements executed".

    Args:
        lock_wait_ms: Milliseconds spent waiting to acquire a connection.
    """
    stats = _active_stats.get()
    if stats is None:
        return
    with stats._lock:  # noqa: SLF001 - the accumulator's own lock
        stats.lock_wait_ms += lock_wait_ms
