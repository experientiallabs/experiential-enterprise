# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the fixed-TTL read cache: hits, expiry, bound, and failures."""

from __future__ import annotations

import pytest

from explabs.caching import TTLCache


class _Clock:
    """Injectable monotonic clock the tests advance by hand (no sleeps)."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _stores_real_values(value: object | None) -> bool:
    """A ``should_store`` predicate that declines negative answers."""
    return value is not None


class _Loader:
    """Counts how many times a miss reached the underlying read."""

    def __init__(self, value: object = "loaded") -> None:
        self.calls = 0
        self.value = value

    def __call__(self) -> object:
        self.calls += 1
        return self.value


def test_a_hit_does_not_reach_the_loader() -> None:
    """The whole point: a warm key costs no query."""
    cache: TTLCache[str, object] = TTLCache(ttl_seconds=5, max_entries=8, clock=_Clock())
    loader = _Loader()

    first = cache.get_or_load("k", loader)
    second = cache.get_or_load("k", loader)

    assert (first, second) == ("loaded", "loaded")
    assert loader.calls == 1


def test_an_entry_expires_exactly_at_its_ttl() -> None:
    """Staleness is bounded by the TTL, which is what the tradeoff is stated against."""
    clock = _Clock()
    cache: TTLCache[str, object] = TTLCache(ttl_seconds=5, max_entries=8, clock=clock)
    loader = _Loader()

    cache.get_or_load("k", loader)
    clock.now += 4.9
    cache.get_or_load("k", loader)
    assert loader.calls == 1

    clock.now += 0.1
    cache.get_or_load("k", loader)
    assert loader.calls == 2


def test_a_refill_starts_a_fresh_ttl() -> None:
    """An entry's life is measured from its own store, not from the first ever."""
    clock = _Clock()
    cache: TTLCache[str, object] = TTLCache(ttl_seconds=5, max_entries=8, clock=clock)
    loader = _Loader()

    cache.get_or_load("k", loader)
    clock.now += 5
    cache.get_or_load("k", loader)  # reload
    clock.now += 4
    cache.get_or_load("k", loader)

    assert loader.calls == 2


def test_none_is_storable_like_any_other_value() -> None:
    """By default a negative answer is an answer, so the box holds None too."""
    cache: TTLCache[str, object | None] = TTLCache(ttl_seconds=5, max_entries=8, clock=_Clock())
    loader = _Loader(value=None)

    assert cache.get_or_load("absent", loader) is None
    assert cache.get_or_load("absent", loader) is None
    assert loader.calls == 1


def test_a_declined_value_is_returned_but_not_stored() -> None:
    """should_store=False answers the caller without taking an entry."""
    cache: TTLCache[str, object | None] = TTLCache(ttl_seconds=5, max_entries=8, clock=_Clock())
    loader = _Loader(value=None)

    assert cache.get_or_load("absent", loader, should_store=_stores_real_values) is None
    assert cache.get_or_load("absent", loader, should_store=_stores_real_values) is None
    assert loader.calls == 2


def test_declined_keys_cannot_evict_stored_ones() -> None:
    """The flood guard: unbounded declining keys never reach the eviction bound.

    Insertion-ordered eviction means whoever inserts fastest wins, so a shared
    cache whose keys come from untrusted input can only stay fair if the
    untrusted keys are never stored at all.
    """
    cache: TTLCache[str, object | None] = TTLCache(ttl_seconds=60, max_entries=2, clock=_Clock())
    warm = _Loader(value="warm")

    cache.get_or_load("warm", warm, should_store=_stores_real_values)
    for index in range(50):
        cache.get_or_load(f"bogus-{index}", _Loader(value=None), should_store=_stores_real_values)

    cache.get_or_load("warm", warm, should_store=_stores_real_values)
    assert warm.calls == 1


def test_the_bound_evicts_the_oldest_entry() -> None:
    """A stream of distinct keys cannot grow the map without limit."""
    cache: TTLCache[str, object] = TTLCache(ttl_seconds=60, max_entries=2, clock=_Clock())
    loaders = {name: _Loader(value=name) for name in ("a", "b", "c")}
    for name in ("a", "b", "c"):
        cache.get_or_load(name, loaders[name])

    # The two newest are still warm; reading them stores nothing, so the check
    # below is not what evicted "a".
    cache.get_or_load("b", loaders["b"])
    cache.get_or_load("c", loaders["c"])
    assert loaders["b"].calls == 1
    assert loaders["c"].calls == 1

    # "a" was pushed out by "c", so it costs a second load.
    cache.get_or_load("a", loaders["a"])
    assert loaders["a"].calls == 2


def test_expired_entries_go_before_live_ones_when_the_bound_bites() -> None:
    """The bound must not evict a live entry while dead ones still occupy it."""
    clock = _Clock()
    cache: TTLCache[str, object] = TTLCache(ttl_seconds=5, max_entries=2, clock=clock)
    stale = _Loader(value="stale")
    fresh = _Loader(value="fresh")

    cache.get_or_load("stale", stale)
    clock.now += 6  # "stale" is now dead but still occupying an entry
    cache.get_or_load("fresh", fresh)
    cache.get_or_load("other", _Loader(value="other"))

    assert cache.get_or_load("fresh", fresh) == "fresh"
    assert fresh.calls == 1


def test_a_failed_load_is_not_remembered() -> None:
    """A transient read failure must not be cached for the TTL."""
    cache: TTLCache[str, object] = TTLCache(ttl_seconds=5, max_entries=8, clock=_Clock())
    attempts = 0

    def flaky() -> object:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            msg = "postgrest said no"
            raise RuntimeError(msg)
        return "recovered"

    with pytest.raises(RuntimeError):
        cache.get_or_load("k", flaky)

    assert cache.get_or_load("k", flaky) == "recovered"
    assert attempts == 2


@pytest.mark.parametrize(("ttl", "bound"), [(0, 8), (-1, 8), (5, 0), (5, -1)])
def test_a_cache_that_could_never_hit_is_refused(ttl: float, bound: int) -> None:
    """A nonsense TTL or bound is a config accident, not a silently inert cache."""
    with pytest.raises(ValueError, match="must be positive"):
        TTLCache[str, object](ttl_seconds=ttl, max_entries=bound)
