# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gateway worker composition, health, drain, and end-to-end serving tests."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Awaitable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import socket as _socket
from typing import Any, cast
from unittest import mock

import httpx
import psycopg
import pytest
import uvicorn
from exp.runtime.gateway.boundary import boundary_protocol_error
from exp.runtime.gateway.budgets import BudgetReservationRejected, BudgetScopeKind
from exp.runtime.gateway.contracts import (
    AttemptId,
    AuthorizationSnapshot,
    DirectTarget,
    ExecutionSnapshot,
    GatewayApiSurface,
    GatewayEvent,
    GatewayEventKind,
    GatewayFailure,
    GatewayMessage,
    GatewayRequest,
    GatewayUsage,
)
from exp.runtime.gateway.execution import GatewayExecutor
from exp.runtime.gateway.interfaces import GatewayClock
from exp.runtime.gateway.ledger import GatewayLedgerError
from exp.runtime.gateway.routing import CatalogRouteResolver, GatewayRoute
from exp.runtime.gateway.service import GatewayService
from exp.runtime.gateway.sqlite.store import (
    AliasNotGrantedError,
    InvalidVirtualKeyError,
    SystemGatewayClock,
)
from fastapi.testclient import TestClient
from psycopg import Cursor
from psycopg.rows import TupleRow

from explabs.gateway.catalog import (
    HOUSE_ORG_SLUG,
    CatalogModelRow,
    CatalogProviderRow,
    GatewayCatalogRefresher,
    GatewayCatalogState,
    OrgAwareRouteResolver,
    PlatformCatalogRows,
    build_catalog_state,
    build_gateway_catalog,
    load_catalog_rows,
    store_gateway_catalog,
)
from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.control_store import PostgresGatewayControlStore
from explabs.gateway.credentials import release_connection_credential
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.ledger import PostgresAttemptLedger
from explabs.gateway.worker import (
    CrashReconciler,
    DispatchKeyRevokedError,
    DispatchLatchShield,
    GatewayWorkerError,
    GatewayWorkerPhase,
    GatewayWorkerRuntime,
    GatewayWorkerSettings,
    RefreshingGatewayExecutor,
    WorkerPresence,
    _native_route_eligible,
    catalog_readiness_probe,
    compose_gateway_worker_runtime,
    create_gateway_worker_app,
    main,
    native_budget_error,
    ping_database,
)

_NOW = datetime(2026, 8, 19, 12, 0, 0, tzinfo=UTC)
_UNREACHABLE_DSN = "postgresql://gateway:placeholder@127.0.0.1:9/postgres"
_DRAIN_CROSS_THREAD_TOLERANCE_SECONDS = 0.01


def _run[T](awaitable: Awaitable[T]) -> T:
    """Drive one awaitable to completion on a fresh event loop."""

    async def wrap() -> T:
        return await awaitable

    return asyncio.run(wrap())


def test_native_route_policy_preserves_shared_replay_and_insurance() -> None:
    """Only unkeyed customer-managed requests use the process-local Rust path."""
    route = cast("GatewayRoute", mock.Mock())
    route.deployment.billing_source.value = "customer_managed"
    request = GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content="hi"),),
    )

    assert _native_route_eligible(route, request)
    assert not _native_route_eligible(
        route,
        request.model_copy(update={"idempotency_key": "shared-operation"}),
    )
    assert not _native_route_eligible(
        route,
        request.model_copy(update={"client_request_id": "shared-operation"}),
    )
    route.deployment.billing_source.value = "host_managed"
    assert not _native_route_eligible(route, request)


def _unused_port() -> int:
    """Reserve one free loopback port."""
    with _socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _settings(**overrides: object) -> GatewayWorkerSettings:
    """Small-bound worker settings for tests."""
    values: dict[str, object] = {
        "worker_id": f"worker-test-{uuid.uuid4().hex[:8]}",
        "database_url": _UNREACHABLE_DSN,
        "drain_key": "test-drain-key",
        "ready_file": f"/tmp/explabs-gateway-worker-test-{uuid.uuid4().hex[:12]}",  # noqa: S108
        "heartbeat_seconds": 0.2,
        "reconcile_interval_seconds": 0.25,
        "reconcile_grace_seconds": 30,
        "request_timeout_seconds": 30,
        "drain_timeout_seconds": 10,
    }
    values.update(overrides)
    return GatewayWorkerSettings.model_validate(values)


# -- loopback provider --------------------------------------------------------


class _LoopbackProvider(BaseHTTPRequestHandler):
    """Serve a finite OpenAI-compatible SSE response over a real loopback socket.

    Mirrors Experiential's launch-test provider; ``frame_delay_seconds`` lets the drain
    test hold a stream in flight.
    """

    calls = 0
    frame_delay_seconds = 0.0

    def do_POST(self) -> None:
        """Read one provider request and stream text, usage, and terminal frames."""
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        assert payload["stream"] is True
        type(self).calls += 1
        frames = (
            _provider_frame(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": "hello "},
                            "finish_reason": None,
                        }
                    ]
                }
            ),
            _provider_frame(
                {"choices": [{"index": 0, "delta": {"content": "world"}, "finish_reason": "stop"}]}
            ),
            _provider_frame({"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 2}}),
            b"data: [DONE]\n\n",
        )
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for frame in frames:
            if type(self).frame_delay_seconds:
                time.sleep(type(self).frame_delay_seconds)
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:
        """Suppress request logs so test output cannot retain payload context."""
        del format, args


def _provider_frame(payload: dict[str, object]) -> bytes:
    """Encode one provider SSE data frame."""
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


@pytest.fixture
def loopback_provider() -> Iterator[str]:
    """Serve the loopback provider and yield its OpenAI-compatible base URL."""
    _LoopbackProvider.calls = 0
    _LoopbackProvider.frame_delay_seconds = 0.0
    port = _unused_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _LoopbackProvider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# -- in-memory catalog and authority ------------------------------------------


def _loopback_rows(
    org_id: str, model_id: str, provider_row_id: str, base_url: str
) -> PlatformCatalogRows:
    """One org-owned local (openai-compatible) model pointed at the loopback."""
    return PlatformCatalogRows(
        models=(
            CatalogModelRow(
                id=model_id,
                slug="gw-worker-loop",
                owning_org_id=org_id,
                status="active",
                supported_params={"temperature": True},
                updated_at=_NOW,
            ),
        ),
        providers=(
            CatalogProviderRow(
                id=provider_row_id,
                model_id=model_id,
                provider="local",
                provider_model_id="loopback-model",
                base_url=base_url,
                billing_source="customer_managed",
                capabilities={"supports_streaming": True},
                status="active",
                created_at=_NOW,
                updated_at=_NOW,
            ),
        ),
        waterfalls=(),
        connections=(),
    )


def _loopback_state(base_url: str, org_id: str) -> GatewayCatalogState:
    """Build one served catalog state over the loopback deployment."""
    build = build_gateway_catalog(
        _loopback_rows(org_id, str(uuid.uuid4()), str(uuid.uuid4()), base_url),
        environment={},
    )
    assert not build.warnings, build.warnings
    return build_catalog_state(
        build,
        environment={},
        release=lambda connection_id: pytest.fail(f"unexpected BYOK release {connection_id}"),
    )


class _StaticCatalogSource:
    """A pre-built catalog state satisfying the worker's CatalogSource seam."""

    def __init__(self, state: GatewayCatalogState | None) -> None:
        self._state = state
        self.refreshes = 0
        self.started = False
        self.stopped = False

    @property
    def loaded(self) -> bool:
        return self._state is not None

    @property
    def state(self) -> GatewayCatalogState:
        if self._state is None:
            message = "catalog not loaded"
            raise GatewayWorkerError(message)
        return self._state

    def state_for_key_if_loaded(self, key: tuple[str, str]) -> GatewayCatalogState | None:
        """Return the static state when it contains the requested catalog key."""
        state = self._state
        if state is None or key not in state.route_catalogs:
            return None
        return state

    def state_for_key(self, key: tuple[str, str]) -> GatewayCatalogState:
        """Return the current static state, including for unknown keys."""
        del key
        return self.state

    def swap(self, state: GatewayCatalogState) -> None:
        self._state = state

    def refresh_now(self) -> bool:
        self.refreshes += 1
        return True

    def start(self) -> None:
        self.started = True

    def stop(self, timeout_seconds: float = 5.0) -> None:
        del timeout_seconds
        self.stopped = True


@dataclass
class _MemoryLedgerCalls:
    """Recorded ledger traffic for assertions."""

    accepted: list[AuthorizationSnapshot] = field(default_factory=list)
    started: list[AttemptId] = field(default_factory=list)
    finished_attempts: list[tuple[AttemptId, bool]] = field(default_factory=list)
    finished_requests: list[str] = field(default_factory=list)
    # Per finish_attempt call: the executor-stamped first-token time (TTFT).
    first_tokens: list[datetime | None] = field(default_factory=list)
    # Per observe_first_token call: the seam-observed request (TTFT fallback).
    observed: list[str] = field(default_factory=list)


class _MemoryLedger:
    """In-memory AttemptLedger recording the calls Experiential's engine makes."""

    def __init__(self) -> None:
        self.calls = _MemoryLedgerCalls()
        self.fail_next_start: Exception | None = None
        self._ordinal = 0

    async def accept_request(self, *, authorization: AuthorizationSnapshot) -> None:
        """Record one accepted request."""
        self.calls.accepted.append(authorization)

    async def start_attempt(
        self,
        *,
        snapshot: ExecutionSnapshot,
        deployment: object,
        attempt_ordinal: int,
        route_depth: int,
        maximum_cost_micro_usd: int | None = None,
        route_reason: str | None = None,
        fallback_reason: str | None = None,
    ) -> AttemptId:
        """Record or fail one attempted dispatch."""
        del (
            snapshot,
            deployment,
            route_depth,
            maximum_cost_micro_usd,
            route_reason,
            fallback_reason,
        )
        if self.fail_next_start is not None:
            failure, self.fail_next_start = self.fail_next_start, None
            raise failure
        self._ordinal = attempt_ordinal
        attempt_id = f"attempt-{uuid.uuid4().hex[:12]}"
        self.calls.started.append(attempt_id)
        return attempt_id

    async def finish_attempt(
        self,
        *,
        attempt_id: AttemptId,
        terminal_event: GatewayEvent | None,
        failure: GatewayFailure | None,
        finalize_request: bool = True,
        first_token_at: datetime | None = None,
    ) -> None:
        """Record one terminal attempt."""
        del terminal_event, failure
        self.calls.finished_attempts.append((attempt_id, finalize_request))
        self.calls.first_tokens.append(first_token_at)

    async def finish_request(
        self,
        *,
        authorization: AuthorizationSnapshot,
        failure: GatewayFailure,
    ) -> None:
        """Record one pre-dispatch terminal request."""
        del failure
        self.calls.finished_requests.append(authorization.request_id)

    def observe_first_token(self, *, request_id: str) -> None:
        """Record that the request emitted its first response token."""
        self.calls.observed.append(request_id)


class _MemoryControlStore:
    """In-memory GatewayControlStore granting one key the catalog's aliases."""

    def __init__(self, raw_key: str, state: GatewayCatalogState) -> None:
        self._raw_key = raw_key
        self._state = state

    def _require_key(self, raw_key: str) -> None:
        if raw_key != self._raw_key:
            message = "invalid key"
            raise InvalidVirtualKeyError(message)

    def authenticate_key(self, *, raw_key: str) -> None:
        self._require_key(raw_key)

    def authenticated_identity(self, *, raw_key: str) -> tuple[str, str]:
        """Return the fixed organization and identity for the valid test key."""
        self._require_key(raw_key)
        return "org-worker-test", "identity-worker-test"

    def authorize_request(
        self,
        *,
        raw_key: str,
        alias: str,
        request: GatewayRequest,
        deadline_monotonic: float,
        app_referer: str | None = None,
        app_title: str | None = None,
    ) -> AuthorizationSnapshot:
        del app_referer, app_title
        self._require_key(raw_key)
        plan = next(
            (item for item in self._state.build.alias_plans if item.alias_name == alias),
            None,
        )
        if plan is None:
            message = "alias is not granted"
            raise AliasNotGrantedError(message)
        return AuthorizationSnapshot(
            request_id=f"req-{uuid.uuid4().hex[:12]}",
            organization_id="org-worker-test",
            identity_id="identity-worker-test",
            virtual_key_id="key-worker-test",
            alias=plan.alias_name,
            alias_revision_id=plan.revision_id,
            target=DirectTarget(pool_id=plan.target.pool_id),
            surface=request.surface,
            catalog_sha256=plan.catalog_sha256,
            canonical_request_sha256="0" * 64,
            deadline_monotonic=deadline_monotonic,
        )

    def granted_aliases(self, *, raw_key: str) -> tuple[str, ...]:
        self._require_key(raw_key)
        return tuple(plan.alias_name for plan in self._state.build.alias_plans)

    def granted_alias_authorities(self, *, raw_key: str) -> tuple[tuple[str, str, str], ...]:
        """Return every in-memory alias with its frozen serving authority."""
        self._require_key(raw_key)
        return tuple(
            (plan.alias_name, plan.revision_id, plan.catalog_sha256)
            for plan in self._state.build.alias_plans
        )


# -- recording database doubles ------------------------------------------------


class _RecordingCursor:
    """Capture SQL calls and answer the reconcile row shape."""

    def __init__(self, log: list[tuple[str, tuple[object, ...]]]) -> None:
        self._log = log

    def execute(self, sql: str, params: tuple[object, ...] = ()) -> _RecordingCursor:
        self._log.append((" ".join(sql.split()), params))
        return self

    def fetchone(self) -> tuple[object, ...]:
        return (0, 0)


class _RecordingDb(GatewayDatabase):
    """GatewayDatabase double that records transactions instead of connecting."""

    def __init__(self) -> None:
        super().__init__(_UNREACHABLE_DSN)
        self.statements: list[tuple[str, tuple[object, ...]]] = []

    @contextmanager
    def transaction(self) -> Iterator[Cursor[TupleRow]]:
        # Narrow test double: the worker only executes and fetches one row,
        # so the recording cursor stands in for psycopg's at this boundary.
        yield cast("Cursor[TupleRow]", _RecordingCursor(self.statements))

    @contextmanager
    def atomic_call(self) -> Iterator[Cursor[TupleRow]]:
        # The ledger's single-statement hot path records identically.
        yield cast("Cursor[TupleRow]", _RecordingCursor(self.statements))


def _runtime(
    settings: GatewayWorkerSettings,
    catalog: _StaticCatalogSource,
    *,
    raw_key: str,
    db: _RecordingDb | None = None,
    ping: bool | None = True,
    ledger: _MemoryLedger | None = None,
) -> GatewayWorkerRuntime:
    """Compose a worker runtime over in-memory authority and a static catalog."""
    recording_db = db if db is not None else _RecordingDb()
    clock: GatewayClock = SystemGatewayClock()
    attempt_ledger = ledger if ledger is not None else _MemoryLedger()
    executor = RefreshingGatewayExecutor(catalog, attempt_ledger)
    service = GatewayService(
        control_store=_MemoryControlStore(raw_key, catalog.state),
        ledger=attempt_ledger,
        # Same deliberate casts as production composition: the service seam
        # annotates concrete classes while both adapters match its call surface.
        routes=cast("CatalogRouteResolver", OrgAwareRouteResolver(catalog)),
        executor=cast("GatewayExecutor", executor),
        clock=clock,
        readiness_probe=catalog_readiness_probe(catalog, clock),
        request_timeout_seconds=settings.request_timeout_seconds,
    )
    return GatewayWorkerRuntime(
        settings=settings,
        db=recording_db,
        catalog=catalog,
        executor=executor,
        service=service,
        presence=WorkerPresence(
            recording_db,
            settings,
            phase=lambda: GatewayWorkerPhase.READY,
            catalog_sha256=lambda: None,
        ),
        reconciler=CrashReconciler(recording_db, settings),
        ping=(lambda: bool(ping)) if ping is not None else lambda: ping_database(_UNREACHABLE_DSN),
    )


# -- settings ------------------------------------------------------------------


def test_settings_require_database_url_and_a_distinct_drain_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """from_env fails loudly on missing variables and key reuse."""
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    monkeypatch.delenv("EXPLABS_GATEWAY_WORKER_KEY", raising=False)
    with pytest.raises(GatewayWorkerError, match="SUPABASE_DB_URL"):
        GatewayWorkerSettings.from_env()
    monkeypatch.setenv("SUPABASE_DB_URL", _UNREACHABLE_DSN)
    with pytest.raises(GatewayWorkerError, match="EXPLABS_GATEWAY_WORKER_KEY"):
        GatewayWorkerSettings.from_env()
    monkeypatch.setenv("EXPLABS_GATEWAY_WORKER_KEY", "shared-key")
    monkeypatch.setenv("EXPLABS_API_KEY", "shared-key")
    with pytest.raises(GatewayWorkerError, match="differ"):
        GatewayWorkerSettings.from_env()
    monkeypatch.setenv("EXPLABS_API_KEY", "public-key")
    settings = GatewayWorkerSettings.from_env()
    assert settings.drain_key == "shared-key"
    assert settings.worker_id


def test_default_deadline_is_sized_for_long_streaming_and_bounded_by_drain() -> None:
    """The request deadline is generous and the drain always outlives it.

    A long streaming completion (thousands of output tokens over minutes) must
    reach its terminal chunk rather than being cut by the deadline, and an
    in-flight request that began just before SIGTERM must be allowed to finish
    inside the graceful drain window, so ``drain_timeout_seconds`` can never be
    smaller than ``request_timeout_seconds``.
    """
    settings = GatewayWorkerSettings(
        worker_id="w",
        database_url="postgres://x",
        drain_key="drain",
    )
    assert settings.request_timeout_seconds >= 600
    assert settings.drain_timeout_seconds >= settings.request_timeout_seconds


def test_startup_path_connects_carry_a_bounded_connect_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The composed pool and catalog connect factory must bound every connect.

    Both open a Postgres connection on the startup path before uvicorn binds; an
    unbounded connect against an unreachable Supabase hangs startup for minutes
    and starves ``/health/ready`` of an honest 503.
    """
    recorded: list[int | None] = []

    def fake_connect(
        dsn: str, *, connect_timeout: int | None = None, **_: object
    ) -> psycopg.Connection[tuple[object, ...]]:
        del dsn
        recorded.append(connect_timeout)
        message = "unreachable"
        raise psycopg.OperationalError(message)

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    runtime = compose_gateway_worker_runtime(_settings())
    try:
        pool_kwargs = cast("dict[str, object]", runtime.db._pool.kwargs)  # noqa: SLF001
        assert cast("int", pool_kwargs["connect_timeout"]) > 0
        refresher = cast("GatewayCatalogRefresher", runtime.catalog)
        with pytest.raises(psycopg.OperationalError):
            refresher._connect()  # noqa: SLF001
    finally:
        runtime.db.close()
    assert recorded
    assert all(timeout is not None and timeout > 0 for timeout in recorded)


def test_startup_fails_fast_and_logs_the_psycopg_error(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    loopback_provider: str,
) -> None:
    """An unreachable database fails startup loudly with the psycopg error logged.

    The bounded connects turn the pre-bind hang into a fast failure; this proves
    that failure is legible — the next hosted attempt surfaces the real
    reachability error in the pod logs instead of ten silent minutes.
    """
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    runtime = _runtime(_settings(), source, raw_key=f"xpl_test_{uuid.uuid4().hex}")

    def unreachable() -> bool:
        message = "connection refused"
        raise psycopg.OperationalError(message)

    # The first catalog build is the startup path's direct DB touch.
    monkeypatch.setattr(source, "refresh_now", unreachable)

    with caplog.at_level(logging.ERROR), pytest.raises(psycopg.OperationalError):
        _run(runtime.startup())
    assert any("could not reach Postgres" in record.getMessage() for record in caplog.records)
    # A failed bootstrap never starts the poll loop or flips the worker ready.
    assert not source.started
    assert runtime.phase is GatewayWorkerPhase.STARTING


# -- executor recomposition ------------------------------------------------------


def test_refreshing_executor_recomposes_per_generation_and_carries_the_latch(
    loopback_provider: str,
) -> None:
    """A catalog swap recomposes the executor; the accounting latch survives it."""
    org_id = str(uuid.uuid4())
    source = _StaticCatalogSource(_loopback_state(loopback_provider, org_id))
    executor = RefreshingGatewayExecutor(source, _MemoryLedger(), retired_probe_seconds=60.0)
    first = executor._generation()  # noqa: SLF001 - generation identity is the invariant
    assert executor._generation() is first  # noqa: SLF001
    assert executor.accounting_healthy()

    source.swap(_loopback_state(loopback_provider, org_id))
    second = executor._generation()  # noqa: SLF001
    assert second is not first
    assert executor.accounting_healthy()

    # A stream from the retired generation loses a terminal accounting write:
    # the worker must latch unhealthy even though a newer generation is live.
    first.mark_accounting_unhealthy()
    assert not executor.accounting_healthy()
    with pytest.raises(Exception, match="accounting"):
        executor.require_healthy()
    # The latch is permanent across further swaps.
    source.swap(_loopback_state(loopback_provider, org_id))
    executor._generation()  # noqa: SLF001
    assert not executor.accounting_healthy()


# -- readiness probe -------------------------------------------------------------


def test_readiness_probe_proves_the_first_alias_and_rejects_an_empty_catalog(
    loopback_provider: str,
) -> None:
    """The probe freezes a synthetic authorization for one activated alias."""
    state = _loopback_state(loopback_provider, str(uuid.uuid4()))
    source = _StaticCatalogSource(state)
    clock: GatewayClock = SystemGatewayClock()
    proof = _run(catalog_readiness_probe(source, clock)())
    plan = state.build.alias_plans[0]
    assert proof.authorization.alias == plan.alias_name
    assert proof.pool_id == plan.target.pool_id
    assert proof.deployment_ids

    empty = _StaticCatalogSource(
        build_catalog_state(
            build_gateway_catalog(
                PlatformCatalogRows(models=(), providers=(), waterfalls=(), connections=()),
                environment={},
            ),
            environment={},
            release=lambda connection_id: pytest.fail(f"unexpected release {connection_id}"),
        )
    )
    with pytest.raises(GatewayWorkerError, match="empty"):
        _run(catalog_readiness_probe(empty, clock)())


# -- presence and reconciler ------------------------------------------------------


def test_presence_publishes_heartbeats_and_the_ready_marker(tmp_path: Path) -> None:
    """Start publishes before the marker exists; stop publishes dead and unlinks."""
    ready_file = tmp_path / "gateway-ready"
    settings = _settings(ready_file=str(ready_file), heartbeat_seconds=30.0)
    db = _RecordingDb()
    presence = WorkerPresence(
        db,
        settings,
        phase=lambda: GatewayWorkerPhase.READY,
        catalog_sha256=lambda: "0" * 64,
    )
    presence.start()
    assert ready_file.exists()
    assert len(db.statements) == 1
    sql, params = db.statements[0]
    assert "gateway_worker_heartbeat" in sql
    assert params[1] == "ready"
    presence.stop()
    assert not ready_file.exists()
    assert db.statements[-1][1][1] == "dead"


def test_reconciler_never_runs_at_boot_and_then_runs_on_cadence() -> None:
    """The first reconcile pass happens one full interval after start."""
    settings = _settings(reconcile_interval_seconds=0.2)
    db = _RecordingDb()
    reconciler = CrashReconciler(db, settings)
    reconciler.start()
    time.sleep(0.05)
    assert db.statements == []
    time.sleep(0.4)
    reconciler.stop()
    assert db.statements
    sql, params = db.statements[0]
    assert "gateway_reconcile_crashed" in sql
    assert params == (30,)


# -- the composed worker app -------------------------------------------------------


def test_startup_is_idempotent_so_the_native_path_can_pre_run_it(
    loopback_provider: str,
) -> None:
    """A pre-started runtime makes the fallback lifespan a fast no-op.

    Regression pin for the production crashloop: Experiential's native server
    gives the embedded Python fallback ~30 seconds to start, while the first
    catalog build alone can exceed that. main() therefore completes startup
    BEFORE serve_native_gateway; the app lifespan must not then re-run
    presence, the first build, or the loops.
    """
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    settings = _settings()
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    runtime = _runtime(settings, source, raw_key=raw_key)

    _run(runtime.startup())
    assert runtime.phase is GatewayWorkerPhase.READY
    assert source.refreshes == 1

    # The second call (what the fallback app's lifespan issues) is a no-op.
    _run(runtime.startup())
    assert source.refreshes == 1

    # The composed app comes up ready instantly over the pre-started runtime
    # and still owns shutdown when the fallback exits.
    app = create_gateway_worker_app(runtime=runtime)
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200
        assert source.refreshes == 1
    assert source.stopped


def test_worker_app_serves_streamed_chat_and_drains_behind_the_deployment_key(
    loopback_provider: str,
) -> None:
    """Streamed /v1 serving, health, and authenticated drain on one composed app."""
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    settings = _settings()
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    ledger = _MemoryLedger()
    runtime = _runtime(settings, source, raw_key=raw_key, ledger=ledger)
    app = create_gateway_worker_app(runtime=runtime)

    with TestClient(app) as client:
        assert client.get("/health/live").status_code == 200
        ready = client.get("/health/ready")
        assert ready.status_code == 200, ready.text
        assert source.started
        assert source.refreshes == 1

        models = client.get("/v1/models", headers={"Authorization": f"Bearer {raw_key}"})
        assert models.status_code == 200
        assert [item["id"] for item in models.json()["data"]] == ["gw-worker-loop"]
        assert models.json()["data"][0]["owned_by"] == "exp"

        text, saw_done = _stream_chat(client, raw_key)
        assert text == "hello world"
        assert saw_done
        # The runtime stamps the winning attempt's first streamed token and
        # hands it to the platform ledger seam at settlement — the source the
        # Logs table's TTFT column is derived from.
        assert ledger.calls.first_tokens
        assert ledger.calls.first_tokens[-1] is not None
        # The platform's own streaming seam observed the first token too (the
        # fallback used when a serving plane omits first_token_at).
        assert ledger.calls.observed

        # Wrong bearer never drains.
        denied = client.post("/internal/drain", headers={"Authorization": "Bearer wrong"})
        assert denied.status_code == 401
        assert runtime.phase is GatewayWorkerPhase.READY

        drained = client.post(
            "/internal/drain", headers={"Authorization": f"Bearer {settings.drain_key}"}
        )
        assert drained.status_code == 200
        assert drained.json()["graceful"] is True
        assert runtime.phase is GatewayWorkerPhase.DRAINING

        after = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {raw_key}"},
            json={
                "model": "gw-worker-loop",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        assert after.status_code == 503
        assert after.json()["error"]["code"] == "gateway_draining"

        not_ready = client.get("/health/ready")
        assert not_ready.status_code == 503
        assert not_ready.json()["checks"]["admitting"] is False
    assert source.stopped


def test_worker_timing_header_follows_the_fixed_setting(
    loopback_provider: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Server-Timing obeys EXPLABS_GATEWAY_TIMING_HEADER; the log line never does."""
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))

    enabled = create_gateway_worker_app(
        runtime=_runtime(_settings(timing_header_enabled=True), source, raw_key=raw_key)
    )
    with TestClient(enabled) as client:
        response = client.get("/v1/models", headers={"Authorization": f"Bearer {raw_key}"})
        assert response.status_code == 200
        assert "app;dur=" in response.headers["server-timing"]
        assert "server-timing" in client.get("/health/live").headers

    # The settings default is off: a production worker leaks no internals.
    disabled = create_gateway_worker_app(runtime=_runtime(_settings(), source, raw_key=raw_key))
    with (
        caplog.at_level(logging.INFO, logger="explabs.request_timing"),
        TestClient(disabled) as client,
    ):
        response = client.get("/v1/models", headers={"Authorization": f"Bearer {raw_key}"})
        assert response.status_code == 200
        assert "server-timing" not in response.headers
        assert "server-timing" not in client.get("/health/live").headers
    line = next(
        record.getMessage()
        for record in caplog.records
        if 'path="/v1/models"' in record.getMessage()
    )
    assert "dur_ms=" in line
    assert "db_n=" in line


def test_dispatch_auth_shield_maps_revocation_and_passes_everything_else(
    loopback_provider: str,
) -> None:
    """Pre-dispatch failures map to non-latching rejections; others pass through."""
    state = _loopback_state(loopback_provider, str(uuid.uuid4()))
    plan = state.build.alias_plans[0]
    deployment = next(
        iter(state.deployments_by_key[(plan.revision_id, plan.catalog_sha256)].values())
    )
    clock: GatewayClock = SystemGatewayClock()
    proof = _run(catalog_readiness_probe(_StaticCatalogSource(state), clock)())
    ledger = _MemoryLedger()
    shield = DispatchLatchShield(ledger)

    def start_one() -> AttemptId:
        return _run(
            shield.start_attempt(
                snapshot=proof,
                deployment=deployment,
                attempt_ordinal=0,
                route_depth=0,
            )
        )

    # Dispatch-time revocation is a typed pre-dispatch rejection: the executor
    # propagates it unchanged (no latch, exp #589), and the shared boundary
    # maps it to the same uniform 401 as every other revoked-key rejection.
    ledger.fail_next_start = InvalidVirtualKeyError("key was revoked before dispatch")
    with pytest.raises(DispatchKeyRevokedError) as rejection:
        start_one()
    assert "revoked" in str(rejection.value)
    mapped = boundary_protocol_error(rejection.value)
    assert mapped.status_code == 401
    assert mapped.detail.code == "invalid_key"

    # A pre-dispatch ledger invariant (e.g. the BYOK snapshot/deployment gate)
    # becomes a deployment-scope rejection so the waterfall skips the route
    # instead of latching the worker; nothing durable was written.
    ledger.fail_next_start = GatewayLedgerError(
        "attempt deployment is absent from the execution snapshot"
    )
    with pytest.raises(BudgetReservationRejected) as invariant:
        start_one()
    assert invariant.value.scope_kind is BudgetScopeKind.DEPLOYMENT
    assert "absent from the execution snapshot" in str(invariant.value)

    # A plain (non-ledger) failure is a real programming/infrastructure fault
    # and must pass through so Experiential's latch still fires.
    ledger.fail_next_start = ValueError("a real accounting failure")
    with pytest.raises(ValueError, match="real accounting failure"):
        start_one()

    attempt_id = start_one()
    assert attempt_id in ledger.calls.started


def test_seam_observed_first_token_backfills_settlement(loopback_provider: str) -> None:
    """A settle without a plane-emitted first_token_at uses the seam observation.

    The emitted value always wins when present, and a request with neither
    settles NULL (never zero) — the contract the Logs TTFT column renders.
    """
    state = _loopback_state(loopback_provider, str(uuid.uuid4()))
    plan = state.build.alias_plans[0]
    deployment = next(
        iter(state.deployments_by_key[(plan.revision_id, plan.catalog_sha256)].values())
    )
    clock: GatewayClock = SystemGatewayClock()
    proof = _run(catalog_readiness_probe(_StaticCatalogSource(state), clock)())
    # The readiness proof carries synthetic identity; the Postgres ledger's
    # attribution parsing needs real-shaped org/key artifact ids.
    proof = proof.model_copy(
        update={
            "authorization": proof.authorization.model_copy(
                update={
                    "organization_id": f"org-{uuid.uuid4()}",
                    "virtual_key_id": f"key-{uuid.uuid4()}",
                }
            )
        }
    )
    db = _RecordingDb()
    ledger = PostgresAttemptLedger(db, clock=clock)
    completed = GatewayEvent(
        kind=GatewayEventKind.COMPLETED,
        sequence_number=1,
        usage=GatewayUsage(input_tokens=2, output_tokens=2),
    )

    def settle_first_token() -> object:
        sql, params = db.statements[-1]
        assert "gateway_settle_attempt" in sql
        return params[-1]

    def start_attempt(ordinal: int) -> AttemptId:
        return _run(
            ledger.start_attempt(
                snapshot=proof,
                deployment=deployment,
                attempt_ordinal=ordinal,
                route_depth=0,
            )
        )

    # The plane omitted first_token_at: the seam observation backfills it.
    attempt_id = start_attempt(0)
    before = clock.now()
    ledger.observe_first_token(request_id=proof.authorization.request_id)
    after = clock.now()
    _run(ledger.finish_attempt(attempt_id=attempt_id, terminal_event=completed, failure=None))
    backfilled = settle_first_token()
    assert isinstance(backfilled, datetime)
    assert before <= backfilled <= after

    # The plane emitted one: it wins over a fresh seam observation.
    attempt_id = start_attempt(1)
    ledger.observe_first_token(request_id=proof.authorization.request_id)
    emitted = datetime(2026, 8, 22, 12, 0, 0, tzinfo=UTC)
    _run(
        ledger.finish_attempt(
            attempt_id=attempt_id,
            terminal_event=completed,
            failure=None,
            first_token_at=emitted,
        )
    )
    assert settle_first_token() == emitted

    # Neither emitted nor observed: settlement stays NULL, never zero.
    attempt_id = start_attempt(2)
    _run(ledger.finish_attempt(attempt_id=attempt_id, terminal_event=completed, failure=None))
    assert settle_first_token() is None


def test_dispatch_time_revocation_never_poisons_worker_readiness(
    loopback_provider: str,
) -> None:
    """The seam case: a revoked-at-dispatch key must not latch /health/ready.

    Experiential classifies failures raised before an attempt ID is returned as
    non-latching. The worker must stay ready and keep serving other keys.
    """
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    ledger = _MemoryLedger()
    runtime = _runtime(_settings(), source, raw_key=raw_key, ledger=ledger)
    app = create_gateway_worker_app(runtime=runtime)
    with TestClient(app) as client:
        ledger.fail_next_start = InvalidVirtualKeyError("key was revoked before dispatch")
        rejected = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {raw_key}"},
            json={"model": "gw-worker-loop", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert rejected.status_code == 502, rejected.text

        assert runtime.executor.accounting_healthy()
        ready = client.get("/health/ready")
        assert ready.status_code == 200, ready.text

        text, saw_done = _stream_chat(client, raw_key)
        assert text == "hello world"
        assert saw_done


def test_pre_dispatch_ledger_invariant_never_poisons_worker_readiness(
    loopback_provider: str,
) -> None:
    """The amplifier case: one attempt's ledger invariant must not latch health.

    A pre-dispatch ``GatewayLedgerError`` is transactional: nothing durable is
    written. Experiential surfaces an internal request failure without marking
    terminal accounting unhealthy, so other requests keep succeeding.
    """
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    ledger = _MemoryLedger()
    runtime = _runtime(_settings(), source, raw_key=raw_key, ledger=ledger)
    app = create_gateway_worker_app(runtime=runtime)
    with TestClient(app) as client:
        ledger.fail_next_start = GatewayLedgerError(
            "attempt deployment is absent from the execution snapshot"
        )
        rejected = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {raw_key}"},
            json={"model": "gw-worker-loop", "messages": [{"role": "user", "content": "hi"}]},
        )
        # Single-rung loopback: the skipped route exhausts the waterfall, so the
        # request fails without any provider dispatch. The point is the next two
        # assertions: the worker is untouched.
        assert rejected.status_code >= 400, rejected.text

        assert runtime.executor.accounting_healthy()
        ready = client.get("/health/ready")
        assert ready.status_code == 200, ready.text

        text, saw_done = _stream_chat(client, raw_key)
        assert text == "hello world"
        assert saw_done


def test_ready_flips_false_when_postgres_is_unreachable(loopback_provider: str) -> None:
    """The real ping against an unreachable Postgres fails the readiness probe."""
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    runtime = _runtime(_settings(), source, raw_key=raw_key, ping=None)
    app = create_gateway_worker_app(runtime=runtime)
    with TestClient(app) as client:
        response = client.get("/health/ready")
        assert response.status_code == 503
        body = response.json()
        assert body["checks"]["database"] is False
        assert body["checks"]["catalog"] is True


def test_drain_waits_for_the_in_flight_stream(loopback_provider: str) -> None:
    """/internal/drain returns only after the admitted stream finishes."""
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    settings = _settings()
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    runtime = _runtime(settings, source, raw_key=raw_key)
    app = create_gateway_worker_app(runtime=runtime)
    _LoopbackProvider.frame_delay_seconds = 0.25

    port = _unused_port()
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="error",
        )
    )
    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started
    try:
        with (
            httpx.Client(base_url=f"http://127.0.0.1:{port}") as client,
            httpx.Client(base_url=f"http://127.0.0.1:{port}") as drain_client,
        ):
            drain_finished_at: list[float] = []

            def drain() -> None:
                response = drain_client.post(
                    "/internal/drain",
                    headers={"Authorization": f"Bearer {settings.drain_key}"},
                )
                assert response.status_code == 200
                assert response.json()["graceful"] is True
                drain_finished_at.append(time.monotonic())

            with client.stream(
                "POST",
                "/v1/chat/completions",
                headers={"Authorization": f"Bearer {raw_key}"},
                json={
                    "model": "gw-worker-loop",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": True,
                },
            ) as response:
                assert response.status_code == 200
                lines = response.iter_lines()
                first = next(line for line in lines if line.startswith("data: "))
                assert first
                drain_thread = threading.Thread(target=drain)
                drain_started_at = time.monotonic()
                drain_thread.start()
                remaining = list(lines)
                stream_finished_at = time.monotonic()
            drain_thread.join(timeout=settings.drain_timeout_seconds)
            assert not drain_thread.is_alive()
            assert any("[DONE]" in line for line in remaining)
            assert drain_finished_at
            assert (
                drain_finished_at[0] - drain_started_at
                >= _LoopbackProvider.frame_delay_seconds - _DRAIN_CROSS_THREAD_TOLERANCE_SECONDS
            )
            # These stamps come from different threads, so exact ordering is noise.
            assert (
                drain_finished_at[0] >= stream_finished_at - _DRAIN_CROSS_THREAD_TOLERANCE_SECONDS
            )
    finally:
        server.should_exit = True
        server_thread.join(timeout=5)


def _stream_chat(client: TestClient, raw_key: str) -> tuple[str, bool]:
    """Stream one chat completion and return (joined text, saw [DONE])."""
    text_parts: list[str] = []
    saw_done = False
    with client.stream(
        "POST",
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={
            "model": "gw-worker-loop",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            payload = line.removeprefix("data: ")
            if payload == "[DONE]":
                saw_done = True
                continue
            chunk = json.loads(payload)
            for choice in chunk.get("choices", ()):
                content = choice.get("delta", {}).get("content")
                if content:
                    text_parts.append(content)
    return "".join(text_parts), saw_done


# -- end to end against real Postgres ----------------------------------------------


@pytest.mark.integration
def test_worker_serves_a_real_xpl_key_end_to_end_against_postgres(
    gateway_harness: GatewayHarness,
    loopback_provider: str,
) -> None:
    """The Done-when: production composition, real key, real ledger rows."""
    dsn = os.environ["SUPABASE_DB_URL"]
    org_id = gateway_harness.seed_org()
    key = gateway_harness.seed_key(org_id)
    model_id, provider_row_id = str(uuid.uuid4()), str(uuid.uuid4())
    slug = f"gw-int-worker-{uuid.uuid4().hex[:8]}"
    gateway_harness.connection.execute(
        """
        insert into public.models (id, slug, display_name, owning_org_id)
        values (%s, %s, 'GW Worker Loopback', %s)
        """,
        (model_id, slug, org_id),
    )
    gateway_harness.connection.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, base_url, owning_org_id,
          billing_source, capabilities
        ) values (
          %s, %s, 'local', 'loopback-model', %s, %s, 'customer_managed',
          '{"supports_streaming": true}'::jsonb
        )
        """,
        (provider_row_id, model_id, loopback_provider, org_id),
    )
    settings = _settings(database_url=dsn)
    runtime = compose_gateway_worker_runtime(settings)
    app = create_gateway_worker_app(runtime=runtime)
    try:
        with TestClient(app) as client:
            ready = client.get("/health/ready")
            assert ready.status_code == 200, ready.text

            _wait_for_worker_state(gateway_harness, settings.worker_id, "ready")

            # Deny-by-default (P-B): the worker has registered the catalog, so the
            # org-scoped alias exists; grant the org's default identity its aliases
            # (as P-A's backfill does in production) so /v1/models lists the slug
            # and the completion authorizes instead of a 403 model_not_granted.
            gateway_harness.connection.execute("select public.gateway_backfill_identity_tier()")

            models = client.get("/v1/models", headers={"Authorization": f"Bearer {key.raw_key}"})
            assert models.status_code == 200
            assert slug in [item["id"] for item in models.json()["data"]]

            text, saw_done = _stream_chat_named(client, key.raw_key, slug)
            assert text == "hello world"
            assert saw_done

            request_row = gateway_harness.fetch_one(
                """
                select terminal_state, api_surface from public.gateway_requests
                 where org_id = %s
                """,
                (org_id,),
            )
            assert request_row == ("completed", "chat_completions")
            attempt_row = gateway_harness.fetch_one(
                """
                select state, billing_source, input_tokens, output_tokens
                  from public.gateway_attempts where org_id = %s
                """,
                (org_id,),
            )
            assert attempt_row is not None
            assert attempt_row[0] == "completed"
            assert attempt_row[1] == "customer_managed"
            assert (attempt_row[2], attempt_row[3]) == (2, 2)
            usage_row = gateway_harness.fetch_one(
                """
                select lane, cost_micro_usd, status from public.gateway_usage_events
                 where org_id = %s
                """,
                (org_id,),
            )
            assert usage_row == ("pass_through", 0, "completed")

            unknown = client.post(
                "/v1/chat/completions",
                headers={"Authorization": "Bearer xpl_not_a_key"},
                json={"model": slug, "messages": [{"role": "user", "content": "hi"}]},
            )
            assert unknown.status_code == 401

            # A revoked key answers 401 on its next request without touching
            # worker health, and other keys keep serving.
            second_key = gateway_harness.seed_key(org_id)
            gateway_harness.connection.execute(
                "update public.api_keys set revoked_at = now() where id = %s",
                (key.api_key_id,),
            )
            revoked = client.post(
                "/v1/chat/completions",
                headers={"Authorization": f"Bearer {key.raw_key}"},
                json={"model": slug, "messages": [{"role": "user", "content": "hi"}]},
            )
            assert revoked.status_code == 401
            assert runtime.executor.accounting_healthy()
            assert client.get("/health/ready").status_code == 200
            text, saw_done = _stream_chat_named(client, second_key.raw_key, slug)
            assert text == "hello world"
            assert saw_done

            drained = client.post(
                "/internal/drain",
                headers={"Authorization": f"Bearer {settings.drain_key}"},
            )
            assert drained.status_code == 200
            _wait_for_worker_state(gateway_harness, settings.worker_id, "draining")
        _wait_for_worker_state(gateway_harness, settings.worker_id, "dead")
    finally:
        _cleanup_worker_fixture(dsn, settings.worker_id, model_id, slug)


@pytest.mark.integration
def test_byok_variant_lane_reserves_and_settles_through_the_real_ledger(
    gateway_harness: GatewayHarness,
) -> None:
    """A public host model routes through an org's BYOK variant on the real ledger.

    Crosses the seam the P0 broke: the org-aware resolver, the org's variant
    deployment id, and the real ``gateway_start_attempt`` / settlement SQL. The
    variant lane only swaps credentials for the same real provider endpoint, so
    no loopback can serve it locally; the /v1 200 + usage of the customer_managed
    serving lane is proven by ``test_worker_serves_a_real_xpl_key...``. Before
    the fix ``OrgAwareRouteResolver`` substituted the variant into the route but
    left the execution snapshot naming the canonical id, so ``start_attempt``
    raised GatewayLedgerError ("attempt deployment is absent from the execution
    snapshot") and every BYOK org's call died pre-dispatch.

    Asserts against real Postgres: (i) the BYOK org resolves to its variant AND
    that variant is named by the rebuilt snapshot; (ii) the real ledger reserves
    and settles an attempt on the variant (``customer_managed``, a
    ``pass_through`` usage event, zero charged money), no snapshot error; (iii)
    an org without a connection resolves to the canonical host deployment.
    """
    dsn = os.environ["SUPABASE_DB_URL"]
    conn = gateway_harness.connection
    house_row = gateway_harness.fetch_one(
        "select id from public.organizations where slug = %s", (HOUSE_ORG_SLUG,)
    )
    assert house_row is not None, "house org seed is required for the host openai lane"
    house_org = str(house_row[0])
    # A house openai connection makes the public host_managed canonical
    # admissible; the BYOK org's own connection is what turns on its variant.
    conn.execute(
        "select public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
        (house_org, "house-openai-credential-canary"),
    )
    org_byok = gateway_harness.seed_org()
    conn.execute(
        "select public.upsert_provider_connection(%s, 'openai', '{}'::jsonb, %s)",
        (org_byok, "orgb-openai-credential-canary"),
    )
    key_byok = gateway_harness.seed_key(org_byok)
    org_host = gateway_harness.seed_org()
    key_host = gateway_harness.seed_key(org_host)
    byok_connection = gateway_harness.fetch_one(
        "select id from public.provider_connections where org_id = %s and provider = 'openai'",
        (org_byok,),
    )
    assert byok_connection is not None
    model_id, provider_row_id = str(uuid.uuid4()), str(uuid.uuid4())
    slug = f"gw-byokvar-{uuid.uuid4().hex[:8]}"
    variant_deployment_id = f"mp-{provider_row_id}-c-{byok_connection[0]}"
    canonical_deployment_id = f"mp-{provider_row_id}"
    conn.execute(
        "insert into public.models (id, slug, display_name) values (%s, %s, 'BYOK Variant Lane')",
        (model_id, slug),
    )
    conn.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, billing_source, capabilities,
          input_micro_usd_per_million, output_micro_usd_per_million,
          pricing_source, pricing_effective_at
        ) values (
          %s, %s, 'openai', 'gpt-byok-wire', 'host_managed',
          '{"supports_streaming": true}'::jsonb, 1000, 2000, 'launch', now()
        )
        """,
        (provider_row_id, model_id),
    )
    db = GatewayDatabase(dsn)
    clock: GatewayClock = SystemGatewayClock()
    try:
        build = build_gateway_catalog(load_catalog_rows(conn), environment={})
        store_gateway_catalog(conn, build)
        state = build_catalog_state(
            build,
            environment={},
            release=lambda connection_id: release_connection_credential(conn, connection_id),
        )
        assert org_byok in build.byok_deployment_variants, build.warnings
        control_store = PostgresGatewayControlStore(db, clock=clock)
        ledger = PostgresAttemptLedger(db, clock=clock)
        resolver = OrgAwareRouteResolver(_StaticCatalogSource(state))

        # (i)+(ii): BYOK org -> variant deployment, rebuilt snapshot, real ledger.
        byok_route = _resolve_and_settle(
            control_store, ledger, resolver, clock, raw_key=key_byok.raw_key, alias=slug
        )
        assert byok_route.deployment.deployment_id == variant_deployment_id
        assert byok_route.deployment.deployment_id in byok_route.snapshot.deployment_ids
        assert gateway_harness.fetch_one(
            "select state, billing_source, deployment_id from public.gateway_attempts where org_id = %s",
            (org_byok,),
        ) == ("completed", "customer_managed", variant_deployment_id)
        assert gateway_harness.fetch_one(
            "select lane, cost_micro_usd, status from public.gateway_usage_events where org_id = %s",
            (org_byok,),
        ) == ("pass_through", 0, "completed")

        # (iii): org without a connection -> canonical host deployment.
        host_route = _resolve_and_settle(
            control_store,
            ledger,
            resolver,
            clock,
            raw_key=key_host.raw_key,
            alias=slug,
            maximum_cost_micro_usd=1000,
        )
        assert host_route.deployment.deployment_id == canonical_deployment_id
        assert host_route.snapshot.deployment_ids == (canonical_deployment_id,)
        assert gateway_harness.fetch_one(
            "select billing_source, deployment_id from public.gateway_attempts where org_id = %s",
            (org_host,),
        ) == ("host_managed", canonical_deployment_id)
    finally:
        db.close()
        _cleanup_alias_and_model(dsn, slug, model_id)
        _cleanup_provider_connections(dsn, (house_org, org_byok))


def _resolve_and_settle(
    control_store: PostgresGatewayControlStore,
    ledger: PostgresAttemptLedger,
    resolver: OrgAwareRouteResolver,
    clock: GatewayClock,
    *,
    raw_key: str,
    alias: str,
    maximum_cost_micro_usd: int | None = None,
) -> GatewayRoute:
    """Authorize, resolve, and settle one completed attempt through the real ledger.

    Returns the resolved route so the caller can assert deployment and snapshot
    identity; the attempt and its usage event are queried from Postgres.
    """
    request = GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content="hi"),),
    )
    authorization = control_store.authorize_request(
        raw_key=raw_key,
        alias=alias,
        request=request,
        deadline_monotonic=clock.monotonic() + 30.0,
    )
    route = _run(
        resolver.resolve(
            authorization=authorization,
            request=request,
            episode_namespace=(
                authorization.organization_id,
                "identity",
                authorization.alias_revision_id,
                "episode",
            ),
        )
    )
    ledger.accept_request_sync(authorization=authorization)
    attempt_id = ledger.start_attempt_sync(
        snapshot=route.snapshot,
        deployment=route.deployment,
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=maximum_cost_micro_usd,
    )
    assert attempt_id
    ledger.finish_attempt_sync(
        attempt_id=attempt_id,
        terminal_event=GatewayEvent(
            kind=GatewayEventKind.COMPLETED,
            sequence_number=1,
            usage=GatewayUsage(input_tokens=2, output_tokens=2),
        ),
        failure=None,
        finalize_request=True,
    )
    return route


def _cleanup_alias_and_model(dsn: str, slug: str, model_id: str) -> None:
    """Remove the alias, its snapshots, and the model rows a variant test seeded."""
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute("set session_replication_role = replica")
        try:
            revision_rows = connection.execute(
                """
                select distinct catalog_sha256 from public.gateway_alias_revisions
                 where alias_id in (
                   select alias_id from public.gateway_aliases where alias_name = %s
                 )
                """,
                (slug,),
            ).fetchall()
            connection.execute(
                """
                delete from public.gateway_alias_revisions where alias_id in (
                  select alias_id from public.gateway_aliases where alias_name = %s
                )
                """,
                (slug,),
            )
            connection.execute("delete from public.gateway_aliases where alias_name = %s", (slug,))
            for (catalog_sha256,) in revision_rows:
                connection.execute(
                    "delete from public.gateway_catalog_snapshots where catalog_sha256 = %s",
                    (catalog_sha256,),
                )
            connection.execute(
                "delete from public.model_providers where model_id = %s", (model_id,)
            )
            connection.execute("delete from public.models where id = %s", (model_id,))
        finally:
            connection.execute("set session_replication_role = origin")


def _cleanup_provider_connections(dsn: str, org_ids: tuple[str, ...]) -> None:
    """Remove the provider_connections a variant-lane test seeded per org."""
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute("set session_replication_role = replica")
        try:
            for org_id in org_ids:
                connection.execute(
                    "delete from public.provider_connections where org_id = %s", (org_id,)
                )
        finally:
            connection.execute("set session_replication_role = origin")


def _stream_chat_named(client: TestClient, raw_key: str, model: str) -> tuple[str, bool]:
    """Stream one chat completion for an arbitrary model slug."""
    text_parts: list[str] = []
    saw_done = False
    with client.stream(
        "POST",
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={
            "model": model,
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    ) as response:
        assert response.status_code == 200, response.read()
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            payload = line.removeprefix("data: ")
            if payload == "[DONE]":
                saw_done = True
                continue
            chunk = json.loads(payload)
            for choice in chunk.get("choices", ()):
                content = choice.get("delta", {}).get("content")
                if content:
                    text_parts.append(content)
    return "".join(text_parts), saw_done


def _wait_for_worker_state(
    harness: GatewayHarness,
    worker_id: str,
    expected: str,
    *,
    deadline_seconds: float = 5.0,
) -> None:
    """Wait for the heartbeat loop to publish one expected worker state."""
    deadline = time.monotonic() + deadline_seconds
    observed: tuple[object, ...] | None = None
    while time.monotonic() < deadline:
        observed = harness.fetch_one(
            "select state from public.gateway_workers where worker_id = %s",
            (worker_id,),
        )
        if observed == (expected,):
            return
        time.sleep(0.05)
    message = f"worker {worker_id} never reached state {expected!r}; last saw {observed!r}"
    raise AssertionError(message)


def _cleanup_worker_fixture(dsn: str, worker_id: str, model_id: str, slug: str) -> None:
    """Remove the rows the worker's own refresher registered for this test."""
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute("set session_replication_role = replica")
        try:
            connection.execute(
                "delete from public.gateway_workers where worker_id = %s", (worker_id,)
            )
            revision_rows = connection.execute(
                """
                select distinct catalog_sha256 from public.gateway_alias_revisions
                 where alias_id in (
                   select alias_id from public.gateway_aliases where alias_name = %s
                 )
                """,
                (slug,),
            ).fetchall()
            connection.execute(
                """
                delete from public.gateway_alias_revisions where alias_id in (
                  select alias_id from public.gateway_aliases where alias_name = %s
                )
                """,
                (slug,),
            )
            connection.execute("delete from public.gateway_aliases where alias_name = %s", (slug,))
            for (catalog_sha256,) in revision_rows:
                connection.execute(
                    "delete from public.gateway_catalog_snapshots where catalog_sha256 = %s",
                    (catalog_sha256,),
                )
            connection.execute(
                "delete from public.model_providers where model_id = %s", (model_id,)
            )
            connection.execute("delete from public.models where id = %s", (model_id,))
        finally:
            connection.execute("set session_replication_role = origin")


# -- Anthropic Messages lane -----------------------------------------------------


def test_worker_app_serves_the_anthropic_messages_lane(loopback_provider: str) -> None:
    """POST /v1/messages translates onto the chat surface, both auth headers.

    Also proves route precedence: the adapter registers before the root wmo
    mount, so a 200 here means the route is reachable at all.
    """
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    settings = _settings()
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    runtime = _runtime(settings, source, raw_key=raw_key)
    app = create_gateway_worker_app(runtime=runtime)

    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200

        # Non-streaming, authenticated the Anthropic way (x-api-key).
        completed = client.post(
            "/v1/messages",
            headers={"x-api-key": raw_key, "anthropic-version": "2023-06-01"},
            json={
                "model": "gw-worker-loop",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        assert completed.status_code == 200, completed.text
        message = completed.json()
        assert message["type"] == "message"
        assert message["role"] == "assistant"
        assert message["model"] == "gw-worker-loop"
        assert message["content"] == [{"type": "text", "text": "hello world"}]
        assert message["stop_reason"] == "end_turn"
        assert message["stop_sequence"] is None
        assert message["usage"] == {"input_tokens": 2, "output_tokens": 2}

        # Streaming, authenticated with a standard Bearer (ANTHROPIC_AUTH_TOKEN).
        events = _stream_messages(client, raw_key)
        names = [name for name, _ in events]
        assert names == [
            "message_start",
            "ping",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
        text = "".join(
            payload["delta"]["text"] for name, payload in events if name == "content_block_delta"
        )
        assert text == "hello world"
        final = dict(events)["message_delta"]
        assert final["delta"] == {"stop_reason": "end_turn", "stop_sequence": None}
        assert final["usage"] == {"input_tokens": 2, "output_tokens": 2}


def test_messages_lane_rejects_in_anthropic_envelopes(loopback_provider: str) -> None:
    """Auth, grant, capability, and unknown-field failures all wear Anthropic shape."""
    raw_key = f"xpl_test_{uuid.uuid4().hex}"
    settings = _settings()
    source = _StaticCatalogSource(_loopback_state(loopback_provider, str(uuid.uuid4())))
    runtime = _runtime(settings, source, raw_key=raw_key)
    app = create_gateway_worker_app(runtime=runtime)
    body = {
        "model": "gw-worker-loop",
        "max_tokens": 64,
        "messages": [{"role": "user", "content": "hi"}],
    }

    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200

        unauthenticated = client.post("/v1/messages", json=body)
        assert unauthenticated.status_code == 401
        assert unauthenticated.json()["error"]["type"] == "authentication_error"

        bad_key = client.post("/v1/messages", headers={"x-api-key": "xpl_wrong"}, json=body)
        assert bad_key.status_code == 401
        assert bad_key.json() == {
            "type": "error",
            "error": {
                "type": "authentication_error",
                "message": (
                    "The gateway key is invalid, expired, or revoked. "
                    "Ask the gateway operator to issue a new virtual key."
                ),
            },
        }

        ungranted = client.post(
            "/v1/messages",
            headers={"x-api-key": raw_key},
            json={**body, "model": "not-granted"},
        )
        assert ungranted.status_code == 403
        assert ungranted.json()["error"]["type"] == "permission_error"

        unknown_field = client.post(
            "/v1/messages", headers={"x-api-key": raw_key}, json={**body, "top_p": 0.5}
        )
        assert unknown_field.status_code == 400
        rejected = unknown_field.json()["error"]
        assert rejected["type"] == "invalid_request_error"
        assert "top_p" in rejected["message"]

        image = client.post(
            "/v1/messages",
            headers={"x-api-key": raw_key},
            json={
                **body,
                "messages": [{"role": "user", "content": [{"type": "image", "source": {}}]}],
            },
        )
        assert image.status_code == 400
        assert "text-only" in image.json()["error"]["message"]

        drained = client.post(
            "/internal/drain", headers={"Authorization": f"Bearer {settings.drain_key}"}
        )
        assert drained.status_code == 200
        count_tokens = client.post(
            "/v1/messages/count_tokens", headers={"x-api-key": raw_key}, json=body
        )
        assert count_tokens.status_code == 404
        assert count_tokens.json() == {
            "type": "error",
            "error": {
                "type": "not_found_error",
                "message": "count_tokens is not served by this gateway.",
            },
        }

        draining = client.post("/v1/messages", headers={"x-api-key": raw_key}, json=body)
        assert draining.status_code == 503
        assert draining.json()["error"]["type"] == "overloaded_error"


def _stream_messages(client: TestClient, raw_key: str) -> list[tuple[str, dict[str, Any]]]:
    """Stream one /v1/messages request and return (event name, payload) pairs."""
    events: list[tuple[str, dict[str, Any]]] = []
    with client.stream(
        "POST",
        "/v1/messages",
        headers={"Authorization": f"Bearer {raw_key}"},
        json={
            "model": "gw-worker-loop",
            "max_tokens": 64,
            "stream": True,
            "messages": [{"role": "user", "content": "hi"}],
        },
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        name: str | None = None
        for line in response.iter_lines():
            if line.startswith("event: "):
                name = line.removeprefix("event: ")
            elif line.startswith("data: ") and name is not None:
                events.append((name, json.loads(line.removeprefix("data: "))))
                name = None
    return events


# Email-verification quota middleware ----------------------------------------


async def _drive_middleware(
    middleware: object, *, path: str, status: int, body: bytes, bearer: str | None
) -> tuple[int, bytes]:
    """Run one HTTP request through an ASGI middleware, returning (status, body)."""
    call = cast("Any", middleware)
    headers: list[tuple[bytes, bytes]] = [(b"content-type", b"application/json")]
    if bearer is not None:
        headers.append((b"authorization", f"Bearer {bearer}".encode()))
    scope = {"type": "http", "path": path, "headers": headers}

    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[dict[str, object]] = []

    async def send(message: dict[str, object]) -> None:
        sent.append(message)

    async def downstream(
        _scope: dict[str, object],
        _receive: object,
        send_inner: Any,
    ) -> None:
        await send_inner(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send_inner({"type": "http.response.body", "body": body})

    call._app = downstream  # noqa: SLF001 - test injects the downstream ASGI app
    await call(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body_out = b"".join(
        cast("bytes", m.get("body", b"")) for m in sent if m["type"] == "http.response.body"
    )
    return cast("int", start["status"]), body_out


_QUOTA_BODY = json.dumps(
    {
        "error": {
            "type": "insufficient_quota",
            "code": "insufficient_quota",
            "message": "monthly gateway allocation is exhausted",
            "param": None,
        }
    }
).encode()


def test_quota_middleware_rewrites_message_for_unverified_org(monkeypatch: Any) -> None:
    """An unverified org's 429 quota body becomes the verify-your-email message."""
    from explabs.gateway import worker as worker_module
    from explabs.gateway.verification_notice import VERIFY_EMAIL_CODE, VERIFY_EMAIL_MESSAGE

    monkeypatch.setattr(worker_module, "org_owner_unverified_for_key", lambda _db, _key: True)
    middleware = worker_module.EmailVerificationQuotaMiddleware(
        None, db=cast("GatewayDatabase", None)
    )
    status, body = asyncio.run(
        _drive_middleware(
            middleware, path="/v1/chat/completions", status=429, body=_QUOTA_BODY, bearer="xpl_x"
        )
    )
    assert status == 429
    payload = json.loads(body)
    assert payload["error"]["message"] == VERIFY_EMAIL_MESSAGE
    assert payload["error"]["code"] == VERIFY_EMAIL_CODE
    # The HTTP quota class is preserved so official clients still branch on it.
    assert payload["error"]["type"] == "insufficient_quota"


def test_native_budget_error_preserves_verification_policy(monkeypatch: Any) -> None:
    """The Rust fast path returns the same actionable verification quota error."""
    from explabs.gateway import native_host
    from explabs.gateway.verification_notice import VERIFY_EMAIL_CODE, VERIFY_EMAIL_MESSAGE

    monkeypatch.setattr(native_host, "org_owner_unverified_for_key", lambda _db, _key: True)
    error = native_budget_error(cast("GatewayDatabase", None), "xpl_key")
    payload = json.loads(error.public_error_json)
    assert payload["status_code"] == 429
    assert payload["code"] == VERIFY_EMAIL_CODE
    assert payload["message"] == VERIFY_EMAIL_MESSAGE
    assert payload["error_type"] == "insufficient_quota"


def test_main_launches_experiential_rust_server(monkeypatch: Any) -> None:
    """The production console entrypoint gives the public socket to Rust."""
    from types import SimpleNamespace

    from explabs.gateway import worker as worker_module

    settings = _settings(maximum_active_requests=17, drain_timeout_seconds=41)
    components = object()
    continuations = object()
    startup_calls: list[str] = []

    async def _startup() -> None:
        startup_calls.append("startup")

    runtime = SimpleNamespace(
        native_components=components,
        continuations=continuations,
        native_ready=lambda: True,
        db=object(),
        startup=_startup,
    )
    app = object()
    control_plane = object()
    native_control_plane = mock.Mock(return_value=control_plane)
    serve = mock.Mock()
    monkeypatch.setattr(
        "sys.argv",
        ["explabs-gateway-worker", "--host", "127.0.0.1", "--port", "9090"],
    )
    monkeypatch.setattr(worker_module.GatewayWorkerSettings, "from_env", lambda: settings)
    monkeypatch.setattr(worker_module, "compose_gateway_worker_runtime", lambda _settings: runtime)
    monkeypatch.setattr(worker_module, "create_gateway_worker_app", lambda **_kwargs: app)
    monkeypatch.setattr(worker_module, "NativeControlPlane", native_control_plane)
    monkeypatch.setattr(worker_module, "serve_native_gateway", serve)

    main()

    # Startup (presence + first catalog build) completes BEFORE the native
    # server takes over; the fallback's ~30s start window never contains it.
    assert startup_calls == ["startup"]
    native_control_plane.assert_called_once()
    assert native_control_plane.call_args.args == (components,)
    assert native_control_plane.call_args.kwargs["continuation_store"] is continuations
    # Production wires the Rust registry's snapshot callback so the hosted
    # metrics body carries a populated data_plane section.
    native = pytest.importorskip("exp_gateway_native")
    assert native_control_plane.call_args.kwargs["data_plane_metrics"] is (
        native.metrics_snapshot_json
    )
    serve.assert_called_once_with(
        app,
        control_plane,
        host="127.0.0.1",
        port=9090,
        max_active_requests=17,
        graceful_timeout_seconds=41,
        native_usage_enabled=False,
    )


def test_composed_control_plane_metrics_snapshot_carries_the_data_plane() -> None:
    """The worker's metrics wiring fills the snapshot's data_plane section.

    Composes a real NativeControlPlane exactly as main() does (the same
    data_plane_metrics provider) and asserts the resulting snapshot exposes
    the native engine's registry instead of a null data_plane.
    """
    from types import SimpleNamespace

    from exp.runtime.gateway.native_bridge import NativeControlPlane as RealNativeControlPlane
    from exp.runtime.gateway.native_components import NativeGatewayComponents

    from explabs.gateway.worker import _data_plane_metrics

    pytest.importorskip("exp_gateway_native")
    provider = _data_plane_metrics()
    assert provider is not None
    components = SimpleNamespace(
        ledger=object(),
        reconciled_expired_requests=0,
        reconciled_unknown_attempts=0,
    )
    control_plane = RealNativeControlPlane(
        # The snapshot read touches only the reconciliation counts; the cast
        # narrows the stub to the protocol at this test boundary.
        cast("NativeGatewayComponents", components),
        data_plane_metrics=provider,
    )
    snapshot = control_plane.metrics_snapshot()
    data_plane = snapshot["data_plane"]
    assert isinstance(data_plane, dict)
    # The registry's stable shape proves this is the native engine's section.
    assert "served_requests" in data_plane
    assert "requests" in data_plane
    control = snapshot["control_plane"]
    assert isinstance(control, dict)
    assert control["accounting_healthy"] is True


def test_quota_middleware_leaves_verified_org_quota_generic(monkeypatch: Any) -> None:
    """A verified org's 429 quota body is left as the generic exhausted message."""
    from explabs.gateway import worker as worker_module

    monkeypatch.setattr(worker_module, "org_owner_unverified_for_key", lambda _db, _key: False)
    middleware = worker_module.EmailVerificationQuotaMiddleware(
        None, db=cast("GatewayDatabase", None)
    )
    status, body = asyncio.run(
        _drive_middleware(
            middleware, path="/v1/chat/completions", status=429, body=_QUOTA_BODY, bearer="xpl_x"
        )
    )
    assert status == 429
    assert json.loads(body) == json.loads(_QUOTA_BODY)


def test_quota_middleware_ignores_non_429_and_messages_path(monkeypatch: Any) -> None:
    """A 200 response and the /v1/messages path pass through the middleware untouched."""
    from explabs.gateway import worker as worker_module

    # Would rewrite if it ran; asserts it does NOT for a 200 or for /v1/messages.
    monkeypatch.setattr(worker_module, "org_owner_unverified_for_key", lambda _db, _key: True)
    middleware = worker_module.EmailVerificationQuotaMiddleware(
        None, db=cast("GatewayDatabase", None)
    )
    ok_status, ok_body = asyncio.run(
        _drive_middleware(
            middleware, path="/v1/chat/completions", status=200, body=b'{"ok":true}', bearer="xpl_x"
        )
    )
    assert ok_status == 200
    assert json.loads(ok_body) == {"ok": True}
    # /v1/messages is the Anthropic lane, which enriches its own envelope.
    msg_status, msg_body = asyncio.run(
        _drive_middleware(
            middleware, path="/v1/messages", status=429, body=_QUOTA_BODY, bearer="xpl_x"
        )
    )
    assert msg_status == 429
    assert json.loads(msg_body) == json.loads(_QUOTA_BODY)
