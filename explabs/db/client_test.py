# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for Supabase client construction."""

from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import ModuleType, SimpleNamespace
from typing import Self, cast

import httpx
import pytest

from explabs.db import client as client_module
from explabs.db.client import (
    _CLIENT_POOL_SIZE,
    _http1_client,
    _pin_postgrest_http1,
    _PooledSupabaseClient,
    _RetryingQueryBuilder,
    _RetryingSupabaseClient,
    get_supabase_client,
    load_supabase_settings,
)
from explabs.db.repositories import (
    DeleteCapableQuery,
    RepositoryError,
    SupabaseClient,
    SupabaseQueryBuilder,
    SupabaseQueryResult,
)


class _FakeSyncClientOptions:
    """Recorded Supabase client options for timeout assertions."""

    def __init__(
        self,
        *,
        postgrest_client_timeout: float,
        storage_client_timeout: int,
    ) -> None:
        self.postgrest_client_timeout = postgrest_client_timeout
        self.storage_client_timeout = storage_client_timeout


class _FlakyBuilder:
    """Fake query builder whose ``execute`` fails a fixed number of times first."""

    def __init__(self, *, fail_times: int) -> None:
        self._fail_times = fail_times
        self.executes = 0

    def select(self, columns: str = "*", *, count: str | None = None) -> Self:
        _ = (columns, count)
        return self

    def insert(self, json: object) -> Self:
        _ = json
        return self

    def eq(self, column: str, value: object) -> Self:
        _ = column, value
        return self

    def delete(self) -> Self:
        return self

    def limit(self, count: int) -> Self:
        _ = count
        return self

    def execute(self) -> SupabaseQueryResult:
        self.executes += 1
        if self.executes <= self._fail_times:
            message = "Server disconnected without sending a response."
            raise httpx.RemoteProtocolError(message)
        return SimpleNamespace(data=[{"id": "1"}])


class _FakeInnerClient:
    """Fake Supabase client returning a single shared flaky builder."""

    def __init__(self, builder: _FlakyBuilder) -> None:
        self._builder = builder
        self.storage = object()

    def table(self, table_name: str) -> _FlakyBuilder:
        _ = table_name
        return self._builder

    def rpc(self, fn: str, params: object = None) -> _FlakyBuilder:
        _ = fn, params
        return self._builder


def _install_fake_supabase(
    monkeypatch: pytest.MonkeyPatch, inner: _FakeInnerClient
) -> list[tuple[str, str, _FakeSyncClientOptions | None]]:
    """Install a fake ``supabase`` module returning ``inner`` and record create calls."""
    calls: list[tuple[str, str, _FakeSyncClientOptions | None]] = []
    module = ModuleType("supabase")
    options_module = ModuleType("supabase.lib.client_options")

    options_module.__dict__["SyncClientOptions"] = _FakeSyncClientOptions

    def create_client(url: str, key: str, options: _FakeSyncClientOptions | None = None) -> object:
        calls.append((url, key, options))
        return inner

    module.__dict__["create_client"] = create_client
    monkeypatch.setitem(sys.modules, "supabase", module)
    monkeypatch.setitem(sys.modules, "supabase.lib.client_options", options_module)
    monkeypatch.setattr(client_module.time, "sleep", lambda _seconds: None)
    return calls


def test_load_supabase_settings_reads_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Supabase settings are loaded from the environment."""
    _set_supabase_env(monkeypatch)

    settings = load_supabase_settings()

    assert settings.url == "http://127.0.0.1:54321"
    assert settings.anon_key == "anon"
    assert settings.service_role_key == "service"
    assert settings.db_url == "postgresql://postgres:postgres@127.0.0.1:54322/postgres"


def test_load_supabase_settings_requires_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing required settings fail clearly."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="SUPABASE_URL must be set"):
        load_supabase_settings()


def test_get_supabase_client_uses_service_role_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Service-role clients use the server-only key."""
    _set_supabase_env(monkeypatch)
    inner = _FakeInnerClient(_FlakyBuilder(fail_times=0))
    calls = _install_fake_supabase(monkeypatch, inner)

    client = get_supabase_client(service_role=True)

    # The wrapper delegates table/rpc/storage to the constructed inner clients.
    assert client.storage is inner.storage
    assert len(calls) == _CLIENT_POOL_SIZE
    assert all(call[0] == "http://127.0.0.1:54321" for call in calls)
    assert all(call[1] == "service" for call in calls)
    options = cast("_FakeSyncClientOptions", calls[0][2])
    assert options.postgrest_client_timeout == 120.0
    assert options.storage_client_timeout == 120


def test_get_supabase_client_honors_http_timeout_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hosted platform persistence can override the Supabase HTTP timeout."""
    _set_supabase_env(monkeypatch)
    monkeypatch.setenv("EXPLABS_SUPABASE_HTTP_TIMEOUT_SECONDS", "90")
    inner = _FakeInnerClient(_FlakyBuilder(fail_times=0))
    calls = _install_fake_supabase(monkeypatch, inner)

    get_supabase_client(service_role=True)

    options = cast("_FakeSyncClientOptions", calls[0][2])
    assert options.postgrest_client_timeout == 90.0
    assert options.storage_client_timeout == 90


def test_get_supabase_client_retries_reads_on_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient PostgREST disconnect on a read is retried transparently."""
    _set_supabase_env(monkeypatch)
    builder = _FlakyBuilder(fail_times=2)
    _install_fake_supabase(monkeypatch, _FakeInnerClient(builder))

    client = get_supabase_client()
    result = client.table("organizations").select("*").eq("id", "1").execute()

    assert result.data == [{"id": "1"}]
    assert builder.executes == 3


def test_get_supabase_client_read_retry_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """Persistent disconnects exhaust the bounded retry and surface the error."""
    _set_supabase_env(monkeypatch)
    builder = _FlakyBuilder(fail_times=99)
    _install_fake_supabase(monkeypatch, _FakeInnerClient(builder))

    client = get_supabase_client()
    with pytest.raises(httpx.RemoteProtocolError):
        client.table("organizations").select("*").execute()

    assert builder.executes == 3


def test_get_supabase_client_retries_writes_on_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A "Server disconnected" write is retried; the request never reached the server."""
    _set_supabase_env(monkeypatch)
    builder = _FlakyBuilder(fail_times=1)
    _install_fake_supabase(monkeypatch, _FakeInnerClient(builder))

    client = get_supabase_client()
    result = client.table("organizations").insert({"id": "1"}).execute()

    assert result.data == [{"id": "1"}]
    assert builder.executes == 2


def test_get_supabase_client_forwards_delete(monkeypatch: pytest.MonkeyPatch) -> None:
    """The retry proxy keeps the underlying builder's delete capability.

    Deleting stores probe for ``DeleteCapableQuery`` at runtime; a proxy that
    drops ``delete`` silently turns every production delete into "not found".
    """
    _set_supabase_env(monkeypatch)
    builder = _FlakyBuilder(fail_times=1)
    _install_fake_supabase(monkeypatch, _FakeInnerClient(builder))

    client = get_supabase_client()
    query = client.table("world_models")
    assert isinstance(query, DeleteCapableQuery)
    result = query.delete().eq("id", "1").execute()

    assert result.data == [{"id": "1"}]
    assert builder.executes == 2


def test_retrying_builder_delete_requires_capable_inner() -> None:
    """Wrapping a delete-less builder fails loudly instead of degrading."""

    class _NoDeleteBuilder:
        def execute(self) -> SupabaseQueryResult:
            return SimpleNamespace(data=[])

    proxy = _RetryingQueryBuilder(
        cast("SupabaseQueryBuilder", _NoDeleteBuilder()), threading.RLock()
    )
    with pytest.raises(RepositoryError, match="does not support delete"):
        proxy.delete()


def test_supabase_client_serializes_concurrent_executes() -> None:
    """One client never overlaps PostgREST exchanges across worker threads."""

    class _BlockingBuilder(_FlakyBuilder):
        def __init__(self) -> None:
            super().__init__(fail_times=0)
            self.entered = threading.Event()
            self.release = threading.Event()
            self.state_lock = threading.Lock()
            self.active = 0
            self.max_active = 0

        def execute(self) -> SupabaseQueryResult:
            with self.state_lock:
                self.active += 1
                self.max_active = max(self.max_active, self.active)
                self.entered.set()
            self.release.wait(timeout=1.0)
            try:
                return SimpleNamespace(data=[{"id": "1"}])
            finally:
                with self.state_lock:
                    self.active -= 1

    builder = _BlockingBuilder()
    client = _RetryingSupabaseClient(cast("SupabaseClient", _FakeInnerClient(builder)))

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(client.table("rollouts").select("*").execute)
        assert builder.entered.wait(timeout=1.0)
        second = pool.submit(client.table("agent_opt_runs").select("*").execute)
        time.sleep(0.05)
        assert builder.max_active == 1
        builder.release.set()
        assert first.result().data == [{"id": "1"}]
        assert second.result().data == [{"id": "1"}]

    assert builder.max_active == 1


def test_pin_postgrest_http1_replaces_session() -> None:
    """The PostgREST session is replaced and the original is closed."""
    original = httpx.Client(
        base_url="https://branch.supabase.co/rest/v1/",
        headers={"apikey": "service"},
        http2=True,
    )
    postgrest = SimpleNamespace(session=original)
    fake_client = SimpleNamespace(postgrest=postgrest)

    _pin_postgrest_http1(fake_client)

    assert postgrest.session is not original
    assert original.is_closed
    assert str(postgrest.session.base_url) == "https://branch.supabase.co/rest/v1/"
    assert postgrest.session.headers["apikey"] == "service"
    postgrest.session.close()


def test_http1_client_disables_http2(monkeypatch: pytest.MonkeyPatch) -> None:
    """The rebuilt client is constructed with HTTP/2 disabled."""
    _set_supabase_env(monkeypatch)
    monkeypatch.setenv("EXPLABS_SUPABASE_HTTP_TIMEOUT_SECONDS", "75")
    original = httpx.Client(
        base_url="https://branch.supabase.co/rest/v1/",
        headers={"apikey": "service"},
        http2=True,
    )
    captured: dict[str, object] = {}

    def recording_client(**kwargs: object) -> httpx.Client:
        captured.update(kwargs)
        return original

    monkeypatch.setattr(client_module.httpx, "Client", recording_client)
    _http1_client(original)

    assert captured["http2"] is False
    assert captured["follow_redirects"] is True
    assert str(captured["base_url"]) == "https://branch.supabase.co/rest/v1/"
    timeout = captured["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert timeout.read == 75.0
    original.close()


def test_pin_postgrest_http1_is_noop_without_session() -> None:
    """A client without a PostgREST httpx session is left untouched."""
    fake_client = SimpleNamespace(postgrest=SimpleNamespace(session=object()))
    _pin_postgrest_http1(fake_client)  # must not raise
    _pin_postgrest_http1(SimpleNamespace())  # no postgrest attribute


def _set_supabase_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set complete Supabase environment variables."""
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:54321")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres")


def test_execute_records_query_timing() -> None:
    """Every PostgREST exchange lands in the active query-timing scope."""
    from explabs.db import query_timing

    class _InstantBuilder:
        def execute(self) -> SupabaseQueryResult:
            return SimpleNamespace(data=[])

    proxy = _RetryingQueryBuilder(
        cast("SupabaseQueryBuilder", _InstantBuilder()), threading.RLock()
    )
    stats = query_timing.begin_recording()
    proxy.execute()
    proxy.execute()
    assert stats.calls == 2
    assert stats.execute_ms >= 0.0
    assert stats.lock_wait_ms >= 0.0


def test_execute_records_timing_even_when_the_query_raises() -> None:
    """A failing exchange still counts toward the request's totals."""
    from explabs.db import query_timing

    class _AlwaysDownBuilder:
        def execute(self) -> SupabaseQueryResult:
            msg = "Server disconnected"
            raise httpx.RemoteProtocolError(msg)

    proxy = _RetryingQueryBuilder(
        cast("SupabaseQueryBuilder", _AlwaysDownBuilder()), threading.RLock()
    )
    stats = query_timing.begin_recording()
    with pytest.raises(httpx.RemoteProtocolError):
        proxy.execute()
    assert stats.calls == 1
    # The in-lock retry backoff (0.1s + 0.2s) is part of the wire time.
    assert stats.execute_ms >= 300.0


def test_pooled_client_runs_exchanges_concurrently() -> None:
    """Separate pool members overlap where one client would serialize."""

    class _SharedGauge:
        def __init__(self) -> None:
            self.state_lock = threading.Lock()
            self.active = 0
            self.max_active = 0
            self.entered = threading.Event()
            self.both = threading.Event()
            self.release = threading.Event()

    gauge = _SharedGauge()

    class _GaugedBuilder(_FlakyBuilder):
        def __init__(self) -> None:
            super().__init__(fail_times=0)

        def execute(self) -> SupabaseQueryResult:
            with gauge.state_lock:
                gauge.active += 1
                gauge.max_active = max(gauge.max_active, gauge.active)
                gauge.entered.set()
                if gauge.active == 2:
                    gauge.both.set()
            gauge.release.wait(timeout=1.0)
            try:
                return SimpleNamespace(data=[{"id": "1"}])
            finally:
                with gauge.state_lock:
                    gauge.active -= 1

    inners = [
        _RetryingSupabaseClient(cast("SupabaseClient", _FakeInnerClient(_GaugedBuilder())))
        for _ in range(2)
    ]
    pooled = _PooledSupabaseClient(inners)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(pooled.table("rollouts").select("*").execute)
        assert gauge.entered.wait(timeout=1.0)
        second = pool.submit(pooled.table("agent_opt_runs").select("*").execute)
        assert gauge.both.wait(timeout=1.0), "second exchange never overlapped the first"
        gauge.release.set()
        assert first.result().data == [{"id": "1"}]
        assert second.result().data == [{"id": "1"}]

    assert gauge.max_active == 2


def test_get_supabase_client_distributes_queries_across_the_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sequential queries round-robin over every constructed session."""
    _set_supabase_env(monkeypatch)
    builders: list[_FlakyBuilder] = []

    module = ModuleType("supabase")
    options_module = ModuleType("supabase.lib.client_options")
    options_module.__dict__["SyncClientOptions"] = _FakeSyncClientOptions

    def create_client(url: str, key: str, options: _FakeSyncClientOptions | None = None) -> object:
        _ = (url, key, options)
        builder = _FlakyBuilder(fail_times=0)
        builders.append(builder)
        return _FakeInnerClient(builder)

    module.__dict__["create_client"] = create_client
    monkeypatch.setitem(sys.modules, "supabase", module)
    monkeypatch.setitem(sys.modules, "supabase.lib.client_options", options_module)

    client = get_supabase_client(service_role=True)
    for _ in range(2 * _CLIENT_POOL_SIZE):
        client.table("rollouts").select("*").execute()

    assert len(builders) == _CLIENT_POOL_SIZE
    assert [builder.executes for builder in builders] == [2] * _CLIENT_POOL_SIZE


def test_http1_client_holds_idle_connections(monkeypatch: pytest.MonkeyPatch) -> None:
    """Idle keepalive must outlive a 5-second dashboard poll cycle."""
    captured: dict[str, object] = {}
    original = httpx.Client(base_url="https://branch.supabase.co/rest/v1/")

    def recording_client(**kwargs: object) -> httpx.Client:
        captured.update(kwargs)
        return original

    monkeypatch.setattr(client_module.httpx, "Client", recording_client)
    _http1_client(original)

    limits = captured["limits"]
    assert isinstance(limits, httpx.Limits)
    assert limits.keepalive_expiry is not None
    assert limits.keepalive_expiry >= 30.0
    assert limits.max_keepalive_connections == 20
    assert limits.max_connections == 100
    original.close()
