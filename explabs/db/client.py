# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Supabase client construction for the Experiential Labs platform."""

from __future__ import annotations

import importlib
import itertools
import os
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Self, cast

import httpx

from explabs.db import query_timing
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonPayload,
    RepositoryError,
    SupabaseClient,
    SupabaseQueryBuilder,
    SupabaseQueryResult,
    SupabaseStorage,
)

# PostgREST runs behind a connection pooler that drops idle keep-alive
# connections. httpx then raises ``RemoteProtocolError`` ("Server disconnected")
# when it reuses a stale one for the next request -- common on a cold worker
# whose pooled connection has gone stale -- surfacing as a flaky 500.
#
# "Server disconnected" means the server closed the connection WITHOUT sending a
# response, so the request was not processed: retrying cannot duplicate the
# effect. We therefore retry every operation (reads and writes) on this specific
# error. Writes are additionally safe because inserts carry client-generated ids
# (a replay of an already-applied insert surfaces as a primary-key conflict, not
# a duplicate row) and updates/upserts/RPCs in this codebase are idempotent.
#
# That retry only covers HTTP/1.1, where a stale pooled connection surfaces as a
# clean ``RemoteProtocolError``. postgrest-py hardcodes ``http2=True``; over
# HTTP/2 the same stale-connection reuse instead raises an unrecoverable
# ``KeyError`` from httpcore (``_response_closed`` deleting an already-removed
# stream id), which the retry cannot catch and surfaces as a flaky 500. We pin
# the PostgREST session to HTTP/1.1 so every transient disconnect stays
# retryable; HTTP/2 multiplexing buys nothing here because PostgREST reads are
# short and already batched.
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF_SECONDS = 0.1
_DEFAULT_HTTP_TIMEOUT_SECONDS = 120.0
_DEFAULT_CONNECT_TIMEOUT_SECONDS = 30.0

# httpx defaults to a 5-second keepalive expiry, so any query arriving after
# a >5s idle gap (a 5-second dashboard poll cycle sits exactly on the edge)
# pays a fresh cross-region TCP+TLS handshake: several round-trips before the
# query even starts. Hold idle connections longer; a connection the pooler
# already dropped surfaces as the retryable HTTP/1.1 RemoteProtocolError this
# module exists to absorb.
_KEEPALIVE_EXPIRY_SECONDS = 60.0
_MAX_KEEPALIVE_CONNECTIONS = 20
_MAX_CONNECTIONS = 100


@dataclass(frozen=True)
class SupabaseSettings:
    """Supabase connection settings.

    Attributes:
        url: Supabase API URL.
        anon_key: Browser-safe anonymous key.
        service_role_key: Server-only service-role key.
        db_url: Direct Postgres connection string.
    """

    url: str
    anon_key: str
    service_role_key: str
    db_url: str


def load_supabase_settings() -> SupabaseSettings:
    """Load Supabase settings from environment variables.

    Returns:
        Supabase settings.

    Raises:
        RuntimeError: If required settings are missing.
    """
    url = _required_env("SUPABASE_URL")
    anon_key = _required_env("SUPABASE_ANON_KEY")
    service_role_key = _required_env("SUPABASE_SERVICE_ROLE_KEY")
    db_url = _required_env("SUPABASE_DB_URL")
    return SupabaseSettings(
        url=url,
        anon_key=anon_key,
        service_role_key=service_role_key,
        db_url=db_url,
    )


class _RetryingQueryBuilder:
    """Thread-safe query proxy that retries pooled disconnects.

    A "Server disconnected" error means the request never reached the server, so
    the proxy retries the chain regardless of verb (see the module note for why
    this is safe for writes as well as reads).
    """

    def __init__(self, inner: SupabaseQueryBuilder, execute_lock: threading.RLock) -> None:
        self._inner = inner
        self._execute_lock = execute_lock

    def _wrap(self, inner: SupabaseQueryBuilder) -> Self:
        """Wrap the next query-builder stage with this client's execute lock."""
        return type(self)(inner, self._execute_lock)

    def select(self, columns: str = "*", *, count: str | None = None) -> Self:
        return self._wrap(self._inner.select(columns, count=count))

    def insert(self, json: JsonPayload | Sequence[JsonPayload]) -> Self:
        return self._wrap(self._inner.insert(json))

    def upsert(
        self,
        json: JsonPayload | Sequence[JsonPayload],
        *,
        on_conflict: str | None = None,
        ignore_duplicates: bool = False,
    ) -> Self:
        return self._wrap(
            self._inner.upsert(json, on_conflict=on_conflict, ignore_duplicates=ignore_duplicates)
        )

    def update(self, json: JsonPayload) -> Self:
        return self._wrap(self._inner.update(json))

    def delete(self) -> Self:
        # The proxy must stay capability-transparent: deleting stores probe for
        # ``DeleteCapableQuery`` at runtime, and dropping ``delete`` here would
        # make every production delete report "not found" while tests against
        # the unwrapped fake keep passing.
        inner = self._inner
        if not isinstance(inner, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        return self._wrap(inner.delete())

    def eq(self, column: str, value: object) -> Self:
        return self._wrap(self._inner.eq(column, value))

    def in_(self, column: str, values: Sequence[object]) -> Self:
        return self._wrap(self._inner.in_(column, values))

    def is_(self, column: str, value: object) -> Self:
        return self._wrap(self._inner.is_(column, value))

    @property
    def not_(self) -> _RetryingNegatedFilter:
        """Forward postgrest's ``not_`` chain, re-wrapping the negated filter."""
        return _RetryingNegatedFilter(self)

    def gt(self, column: str, value: object) -> Self:
        return self._wrap(self._inner.gt(column, value))

    def gte(self, column: str, value: object) -> Self:
        return self._wrap(self._inner.gte(column, value))

    def lte(self, column: str, value: object) -> Self:
        return self._wrap(self._inner.lte(column, value))

    def order(self, column: str, *, desc: bool = False) -> Self:
        return self._wrap(self._inner.order(column, desc=desc))

    def limit(self, count: int) -> Self:
        return self._wrap(self._inner.limit(count))

    def range(self, start: int, end: int) -> Self:
        return self._wrap(self._inner.range(start, end))

    def execute(self) -> SupabaseQueryResult:
        # A sync httpx client is nominally thread-safe, but postgrest-py's
        # shared request/session stack can race connection teardown under the
        # optimizer's high fan-out. Keep model and sandbox work concurrent while
        # making each short PostgREST exchange atomic on this client.
        lock_requested = time.perf_counter()
        with self._execute_lock:
            lock_acquired = time.perf_counter()
            try:
                for attempt in range(_RETRY_ATTEMPTS - 1):
                    try:
                        return self._inner.execute()
                    except httpx.RemoteProtocolError:
                        time.sleep(_RETRY_BACKOFF_SECONDS * (attempt + 1))
                # Final attempt: a persistent disconnect propagates to the caller.
                return self._inner.execute()
            finally:
                query_timing.record_query(
                    lock_wait_ms=(lock_acquired - lock_requested) * 1000.0,
                    execute_ms=(time.perf_counter() - lock_acquired) * 1000.0,
                )


class _RetryingNegatedFilter:
    """The ``not_`` chain over the retrying proxy: negate, then re-wrap."""

    def __init__(self, builder: _RetryingQueryBuilder) -> None:
        self._builder = builder

    def is_(self, column: str, value: object) -> _RetryingQueryBuilder:
        """Apply a negated IS filter on the inner builder, re-wrapped."""
        inner = self._builder._inner.not_.is_(column, value)  # noqa: SLF001 - proxy pair
        return self._builder._wrap(inner)  # noqa: SLF001 - proxy pair


class _RetryingSupabaseClient:
    """Supabase client wrapper that hardens calls against pooled disconnects."""

    def __init__(self, inner: SupabaseClient) -> None:
        self._inner = inner
        self._execute_lock = threading.RLock()
        self.storage: SupabaseStorage = inner.storage

    def table(self, table_name: str) -> SupabaseQueryBuilder:
        return _RetryingQueryBuilder(self._inner.table(table_name), self._execute_lock)

    def rpc(self, fn: str, params: JsonPayload | None = None) -> SupabaseQueryBuilder:
        return _RetryingQueryBuilder(self._inner.rpc(fn, params), self._execute_lock)


# Independent clients (each with its own httpx session and execute lock) the
# process round-robins queries across. One client meant one lock meant every
# PostgREST exchange in the process was mutually exclusive: measured on the
# PR-416 preview, 12 concurrent dashboard reads queued a /v1 call's queries
# for 7.9 of its 8.8 seconds. Eight locks bound concurrency without giving up
# the per-session serialization the retry contract assumes.
_CLIENT_POOL_SIZE = 8


class _PooledSupabaseClient:
    """Round-robin over independent hardened clients; storage rides the first.

    Query chains stay on the client that started them (``table``/``rpc`` hand
    out that client's builder), so each session still sees one exchange at a
    time while the process runs up to pool-size exchanges concurrently.
    """

    def __init__(self, inners: Sequence[_RetryingSupabaseClient]) -> None:
        if not inners:
            msg = "client pool requires at least one inner client"
            raise ValueError(msg)
        self._inners = tuple(inners)
        self._counter = itertools.count()
        self.storage: SupabaseStorage = self._inners[0].storage

    def _next_inner(self) -> _RetryingSupabaseClient:
        return self._inners[next(self._counter) % len(self._inners)]

    def table(self, table_name: str) -> SupabaseQueryBuilder:
        return self._next_inner().table(table_name)

    def rpc(self, fn: str, params: JsonPayload | None = None) -> SupabaseQueryBuilder:
        return self._next_inner().rpc(fn, params)


def get_supabase_client(*, service_role: bool = False) -> SupabaseClient:
    """Create a Supabase client.

    Args:
        service_role: Whether to use the server-only service-role key.

    Returns:
        Supabase client constrained to the platform's repository protocol:
        a fixed-size pool of independent sessions queries round-robin across,
        each wrapped with a bounded retry on transient PostgREST "Server
        disconnected" errors.
    """
    settings = load_supabase_settings()
    module = importlib.import_module("supabase")
    create_client = module.create_client
    client_options_type = importlib.import_module("supabase.lib.client_options").SyncClientOptions
    key = settings.service_role_key if service_role else settings.anon_key
    timeout_seconds = _supabase_http_timeout_seconds()
    inners: list[_RetryingSupabaseClient] = []
    for _ in range(_CLIENT_POOL_SIZE):
        client = create_client(
            settings.url,
            key,
            client_options_type(
                postgrest_client_timeout=timeout_seconds,
                storage_client_timeout=int(timeout_seconds),
            ),
        )
        _pin_postgrest_http1(client)
        inners.append(_RetryingSupabaseClient(cast("SupabaseClient", client)))
    return cast("SupabaseClient", _PooledSupabaseClient(inners))


def _pin_postgrest_http1(client: object) -> None:
    """Force the PostgREST httpx session onto HTTP/1.1.

    Replaces the http2-enabled session postgrest-py builds with an otherwise
    identical HTTP/1.1 one (see the module note), so stale-connection reuse
    raises a retryable ``RemoteProtocolError`` instead of the httpcore HTTP/2
    ``KeyError``. No-op if the client does not expose the expected attributes.
    """
    postgrest = getattr(client, "postgrest", None)
    if postgrest is None:
        return
    session = getattr(postgrest, "session", None)
    if not isinstance(session, httpx.Client):
        return
    postgrest.session = _http1_client(session)
    session.close()


def _http1_client(session: httpx.Client) -> httpx.Client:
    """Return an HTTP/1.1 httpx client mirroring an existing session's config."""
    return httpx.Client(
        base_url=session.base_url,
        headers=session.headers,
        timeout=_supabase_http_timeout(),
        follow_redirects=True,
        http2=False,
        limits=httpx.Limits(
            max_connections=_MAX_CONNECTIONS,
            max_keepalive_connections=_MAX_KEEPALIVE_CONNECTIONS,
            keepalive_expiry=_KEEPALIVE_EXPIRY_SECONDS,
        ),
    )


def _supabase_http_timeout_seconds() -> float:
    """Return the configured Supabase HTTP timeout in seconds."""
    raw = os.environ.get(
        "EXPLABS_SUPABASE_HTTP_TIMEOUT_SECONDS",
        str(_DEFAULT_HTTP_TIMEOUT_SECONDS),
    )
    return float(raw)


def _supabase_http_timeout() -> httpx.Timeout:
    """Build the httpx timeout used for PostgREST and storage calls."""
    seconds = _supabase_http_timeout_seconds()
    return httpx.Timeout(seconds, connect=_DEFAULT_CONNECT_TIMEOUT_SECONDS)


def _required_env(name: str) -> str:
    """Return a required environment variable.

    Args:
        name: Environment variable name.

    Returns:
        Environment variable value.

    Raises:
        RuntimeError: If the value is missing.
    """
    value = os.environ.get(name)
    if not value:
        msg = f"{name} must be set"
        raise RuntimeError(msg)
    return value
