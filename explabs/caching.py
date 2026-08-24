# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""A fixed-TTL, bounded, thread-safe in-process read cache.

Production pays roughly 100ms per PostgREST query because the database is a
region away, and the serving path repeats a handful of reads on every single
request. Caching those for a few seconds removes most of that cost, but every
use is a BOUNDED-STALENESS tradeoff and must be justified as one: a call site
names its TTL as a module constant and says in a comment what can be stale,
for how long, and who is harmed by it.

Per process, deliberately. Several api pods serve concurrently, so the TTL is
the only bound on how long a write takes to reach every reader; there is no
invalidation channel, and adding one would make this a distributed cache
rather than the small thing it is. That is the reason the TTLs here are
seconds rather than minutes.

Only cache reads whose staleness is survivable. Anything that gates money at
the moment it is spent, or that authorizes a request, belongs on the live
path: the api-key lookup behind /v1 is deliberately NOT cached, because key
revocation latency is a security property.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from dataclasses import dataclass


@dataclass(frozen=True)
class _Entry[V]:
    """One cached value and the clock reading at which it goes stale.

    The value is boxed rather than stored bare so that ``None`` is storable
    like any other value, for callers that want to remember a negative answer.
    Whether a given cache SHOULD remember one is the caller's decision, made
    per call through ``get_or_load``'s ``should_store``.
    """

    value: V
    expires_at: float


class TTLCache[K: Hashable, V]:
    """Fixed-TTL cache with a bounded entry count, safe across threads.

    Eviction is insertion-ordered (oldest first) once the bound is reached,
    after expired entries have been dropped. There is no LRU bookkeeping: with
    a TTL this short, entry lifetime is decided by the clock.

    The bound is a last-resort memory guard, NOT a fairness mechanism, and the
    difference matters when a cache is shared across tenants. Insertion-ordered
    eviction means whoever inserts fastest wins: a caller that can mint
    unbounded distinct keys inside one TTL window will evict every other
    caller's warm entries, which is a cross-tenant latency attack even though
    no value is ever served to the wrong caller. Keeping the key space bounded
    per caller is therefore the CALLER's job. ``should_store`` is the tool for
    it: declining to store answers an untrusted key could produce (typically
    the negative ones) means those keys occupy nothing at all.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float,
        max_entries: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Initialize an empty cache.

        Args:
            ttl_seconds: How long an entry stays live after it is stored.
            max_entries: Hard bound on retained entries.
            clock: Monotonic seconds source; tests inject a fake so expiry is
                exercised without sleeping.

        Raises:
            ValueError: If the TTL or the bound is not positive. Either would
                mean "cache nothing" spelled as a configuration accident, and a
                cache that silently never hits is worse than no cache at all.
        """
        if ttl_seconds <= 0:
            msg = f"ttl_seconds must be positive: {ttl_seconds!r}"
            raise ValueError(msg)
        if max_entries <= 0:
            msg = f"max_entries must be positive: {max_entries!r}"
            raise ValueError(msg)
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._clock = clock
        self._entries: OrderedDict[K, _Entry[V]] = OrderedDict()
        self._lock = threading.Lock()

    def get_or_load(
        self,
        key: K,
        loader: Callable[[], V],
        *,
        should_store: Callable[[V], bool] | None = None,
    ) -> V:
        """Return the live value for ``key``, loading it on a miss.

        The loader runs OUTSIDE the lock. These entries are filled by a round
        trip to PostgREST, and holding a process-wide lock across that would
        serialize every concurrent request through one query, which costs more
        than the cache saves. Two callers racing the same cold key both load
        and the later store wins; that is exactly as correct as one load, since
        both are reads of the same row.

        A loader that raises stores nothing, so a transient failure is not
        remembered for the TTL.

        Args:
            key: Cache key.
            loader: Produces the value on a miss.
            should_store: Decides whether a freshly loaded value is worth an
                entry; ``None`` stores every value. Return ``False`` to answer
                the caller without occupying the map, which is how a cache
                whose keys come from untrusted input stays flood-proof (see the
                class docstring): keys that only ever produce declined values
                cost nothing to evict because they were never stored.

        Returns:
            The cached value, or the freshly loaded one.
        """
        now = self._clock()
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None and entry.expires_at > now:
                return entry.value
        value = loader()
        if should_store is not None and not should_store(value):
            return value
        with self._lock:
            self._entries[key] = _Entry(value=value, expires_at=self._clock() + self._ttl_seconds)
            self._entries.move_to_end(key)
            self._evict()
        return value

    def _evict(self) -> None:
        """Drop expired entries, then the oldest, until the bound holds.

        Caller holds the lock.
        """
        now = self._clock()
        for key in [key for key, entry in self._entries.items() if entry.expires_at <= now]:
            del self._entries[key]
        while len(self._entries) > self._max_entries:
            self._entries.popitem(last=False)
