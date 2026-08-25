# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Hosted Rust gateway worker with Experiential's Python fallback over Postgres.

Composes Experiential's native control plane and fallback service from injected
parts: the Platform-owned Postgres authority and attempt ledger, live catalog,
durable replay/continuation stores, and hosted policy adapters.

Deliberately NOT used from Experiential: ``exp run``, ``load_local_gateway``, and
``gateway_instance_lock`` (single-process localhost enforcement), and the
lifecycle/composition outer applications (their ``/usage`` routes are
unauthenticated, their readiness freezes a boot-time snapshot, and their
boot-time crash reconciler would corrupt sibling workers' live attempts).

This module owns the outer application instead:

- ``GET /health/live`` — process liveness.
- ``GET /health/ready`` — a fresh short-lived Postgres ping, catalog loaded,
  Experiential's accounting-healthy latch, and admission (drain flips it false).
- ``POST /internal/drain`` — deployment-key bearer only; stops admission and
  waits for in-flight streams within the configured bound.

Crash reconciliation NEVER runs at boot: a 60s background loop calls
``gateway_reconcile_crashed`` whose internal advisory lock makes the
every-worker invocation safe, with the first invocation one full interval
after startup so a restarting worker can never terminalize a sibling's (or
its own surviving) live attempts.

SIGTERM shutdown stays under the hosting platform's 660s grace: uvicorn waits for open
connections (bounded by ``request_timeout_seconds``) up to the connection
bound, then the lifespan teardown drains the service and publishes the
``dead`` heartbeat, totalling under ``drain_timeout_seconds`` (630s). The
request deadline is sized for long streaming completions (thousands of
output tokens over minutes), so the drain and the hosting platform grace scale with it.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import logging
import os
import secrets
import socket
import threading
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Protocol, cast

import psycopg
from exp.common.models.gateway_catalog import ExactModelDeployment
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
    GatewayFailureClass,
    GatewayRequest,
)
from exp.runtime.gateway.execution import (
    GatewayExecutionError,
    GatewayExecutionStream,
    GatewayExecutor,
)
from exp.runtime.gateway.health import DeploymentHealthRegistry
from exp.runtime.gateway.interfaces import AttemptLedger, GatewayClock, GatewayControlStore
from exp.runtime.gateway.ledger import AttemptRejectedError, GatewayLedgerError
from exp.runtime.gateway.native_bridge import NativeControlPlane, NativeGatewayComponents
from exp.runtime.gateway.native_server import serve_native_gateway
from exp.runtime.gateway.routing import CatalogRouteResolver, GatewayRoute
from exp.runtime.gateway.service import GatewayService, create_gateway_app
from exp.runtime.gateway.sqlite.store import InvalidVirtualKeyError, SystemGatewayClock
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from explabs.gateway.anthropic_messages import register_messages_route
from explabs.gateway.capture import PromptCaptureBuffer, PromptCaptureWriter
from explabs.gateway.catalog import (
    GatewayCatalogRefresher,
    GatewayCatalogState,
    OrgAwareRouteResolver,
)
from explabs.gateway.control_store import PostgresGatewayControlStore
from explabs.gateway.cost_annotation import CostRegistry, UsageCostAnnotator
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.lease_shadow import LeaseShadow, PostgresLeaseStateReader
from explabs.gateway.ledger import PostgresAttemptLedger
from explabs.gateway.lineage import RequestLineageTracker
from explabs.gateway.native_host import HostedNativeGatewayComponents, native_budget_error
from explabs.gateway.promo_notice import (
    apply_promo_exhausted_notice,
    promo_exhausted_label_for_key,
)
from explabs.gateway.protocol_state import PostgresContinuationStore, PostgresReplayStore
from explabs.gateway.verification_notice import (
    apply_verify_email_notice,
    is_insufficient_quota_envelope,
    org_owner_unverified_for_key,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from exp.runtime.openai_protocol.state import BoundedContinuationStore

logger = logging.getLogger(__name__)

DEFAULT_READY_FILE = "/tmp/explabs-gateway-worker-ready"  # noqa: S108

# The readiness ping must answer quickly enough for a container probe window.
_READY_PING_CONNECT_TIMEOUT_SECONDS = 3

# The startup path (presence heartbeat through the pool, first catalog build)
# is the only path that opens a fresh Postgres connection before uvicorn binds.
# Bound it so an unreachable database fails startup in seconds with the psycopg
# error logged, instead of hanging pre-bind and starving the readiness probe.
_STARTUP_CONNECT_TIMEOUT_SECONDS = 10

# Retired executors are probed for the accounting latch until every stream
# they could still be settling has passed its request-wide deadline.
_RETIRED_EXECUTOR_PROBE_MARGIN_SECONDS = 60.0


class GatewayWorkerError(RuntimeError):
    """The gateway worker is misconfigured or cannot prove a servable route."""


class GatewayWorkerPhase(StrEnum):
    """Worker lifecycle phase; values match the ``gateway_workers`` state check."""

    STARTING = "starting"
    READY = "ready"
    DRAINING = "draining"
    DEAD = "dead"


class GatewayWorkerSettings(BaseModel):
    """Bounded runtime settings for one gateway worker process."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    worker_id: str = Field(min_length=1, max_length=128)
    database_url: str = Field(min_length=1)
    drain_key: str = Field(min_length=1)
    app_version: str = Field(default="dev", min_length=1, max_length=128)
    ready_file: str = Field(default=DEFAULT_READY_FILE, min_length=1)
    heartbeat_seconds: float = Field(default=20, gt=0)
    reconcile_interval_seconds: float = Field(default=60, gt=0)
    reconcile_grace_seconds: int = Field(default=30, ge=0)
    # Sized for long streaming completions: a large output (thousands of
    # tokens, minutes of generation) must reach its terminal SSE chunk with
    # finish_reason and usage rather than being cut mid-stream by the deadline.
    request_timeout_seconds: float = Field(default=600, gt=0)
    # Must stay >= request_timeout_seconds so an in-flight request that began
    # just before SIGTERM can finish within the graceful drain window.
    drain_timeout_seconds: float = Field(default=630, gt=0)
    maximum_active_requests: int = Field(default=64, ge=1)
    # Server-Timing exposes query counts and db wire time — an internals
    # oracle customers must not read — so production leaves it off and
    # local/CI stacks opt in; the request timing LOG line is unconditional.
    timing_header_enabled: bool = False
    # Measure-only budget-lease shadow on the host lane (lease_shadow.py):
    # records what a leased in-memory admission WOULD have decided alongside
    # every synchronous reservation. Off by default; enforcement is unchanged
    # either way, so this is a measurement lane, not a serving mode.
    lease_shadow_enabled: bool = False

    @classmethod
    def from_env(cls) -> GatewayWorkerSettings:
        """Load worker settings from trusted deployment environment variables.

        Raises:
            GatewayWorkerError: A required variable is missing, or the drain
                key equals the public deployment key (the drain surface must
                never be reachable with a credential other services hold).
        """
        database_url = os.environ.get("SUPABASE_DB_URL", "").strip()
        if not database_url:
            msg = "SUPABASE_DB_URL must be set for the gateway worker"
            raise GatewayWorkerError(msg)
        drain_key = os.environ.get("EXPLABS_GATEWAY_WORKER_KEY", "").strip()
        if not drain_key:
            msg = "EXPLABS_GATEWAY_WORKER_KEY must be set for the gateway worker"
            raise GatewayWorkerError(msg)
        public_key = os.environ.get("EXPLABS_API_KEY", "").strip()
        if public_key and secrets.compare_digest(drain_key, public_key):
            msg = "EXPLABS_GATEWAY_WORKER_KEY must differ from EXPLABS_API_KEY"
            raise GatewayWorkerError(msg)
        configured_id = os.environ.get("EXPLABS_GATEWAY_WORKER_ID", "").strip()
        worker_id = configured_id or (
            f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(4)}"
        )
        return cls(
            worker_id=worker_id,
            database_url=database_url,
            drain_key=drain_key,
            app_version=os.environ.get("EXPLABS_APP_VERSION", "").strip() or "dev",
            ready_file=os.environ.get("EXPLABS_GATEWAY_WORKER_READY_FILE", DEFAULT_READY_FILE),
            heartbeat_seconds=float(
                os.environ.get("EXPLABS_GATEWAY_WORKER_HEARTBEAT_SECONDS", "20")
            ),
            reconcile_interval_seconds=float(
                os.environ.get("EXPLABS_GATEWAY_RECONCILE_INTERVAL_SECONDS", "60")
            ),
            reconcile_grace_seconds=int(
                os.environ.get("EXPLABS_GATEWAY_RECONCILE_GRACE_SECONDS", "30")
            ),
            request_timeout_seconds=float(
                os.environ.get("EXPLABS_GATEWAY_REQUEST_TIMEOUT_SECONDS", "600")
            ),
            drain_timeout_seconds=float(
                os.environ.get("EXPLABS_GATEWAY_DRAIN_TIMEOUT_SECONDS", "630")
            ),
            timing_header_enabled=(
                os.environ.get("EXPLABS_GATEWAY_TIMING_HEADER", "").strip().lower() in {"1", "true"}
            ),
            lease_shadow_enabled=(
                os.environ.get("EXPLABS_GATEWAY_LEASE_SHADOW", "").strip().lower() in {"1", "true"}
            ),
        )


class CatalogSource(Protocol):
    """The catalog surface the worker composes against.

    ``GatewayCatalogRefresher`` satisfies this structurally; tests may inject
    a static source.
    """

    @property
    def loaded(self) -> bool:
        """Whether a catalog state has been built at least once."""
        ...

    @property
    def state(self) -> GatewayCatalogState:
        """The current immutable catalog state."""
        ...

    def state_for_key_if_loaded(self, key: tuple[str, str]) -> GatewayCatalogState | None:
        """Return the current state when it contains the requested catalog key."""
        ...

    def state_for_key(self, key: tuple[str, str]) -> GatewayCatalogState:
        """Return a state containing the requested catalog key."""
        ...

    def refresh_now(self) -> bool:
        """Build and swap the state when the input watermark changed."""
        ...

    def start(self) -> None:
        """Start the background poll loop."""
        ...

    def stop(self, timeout_seconds: float = 5.0) -> None:
        """Stop the background poll loop."""
        ...


class DispatchKeyRevokedError(AttemptRejectedError, InvalidVirtualKeyError):
    """A key revocation surfaced by the reservation seam instead of at accept.

    Dual inheritance is the contract: ``AttemptRejectedError`` (exp #589) makes
    the executor propagate it unchanged — no accounting latch, no waterfall
    advance, no reshaping — while ``InvalidVirtualKeyError`` makes the shared
    exception boundary answer the exact uniform 401 an accept-time or
    authorization-time revocation produces (no oracle between the cases). The
    settlement failure only matters if the pre-dispatch finalization can still
    write, which a genuinely revoked key cannot (the ledger drops that lazy
    write); it carries the authentication shape for completeness.
    """

    def __init__(self, message: str) -> None:
        """Retain the internal message with the authentication settlement shape."""
        super().__init__(
            message,
            failure=GatewayFailure(
                failure_class=GatewayFailureClass.AUTHENTICATION,
                safe_message="the gateway key was revoked before provider dispatch",
            ),
        )


class DispatchLatchShield:
    """AttemptLedger decorator: a per-attempt dispatch failure must never latch.

    Experiential's executor latches accounting-unhealthy for ANY untyped
    ``start_attempt`` failure (execution.py calls ``_accounting_failure`` when
    the attempt id is still ``None``), so one bad attempt degrades
    ``/health/ready`` for the whole worker and every org. But ``start_attempt``
    is transactional: it either reserves the attempt and returns an id, or it
    fails and rolls back writing nothing durable. A pre-dispatch failure is an
    attempt-level error, never a lost terminal accounting write, so it must not
    be a worker-health event. The shield scopes two such cases so a single
    attempt cannot poison the surface:

    - Dispatch-time key revocation. int-P1 gates revoked/expired keys at
      dispatch as well as at accept (SQLSTATE 42501, surfaced by the P2 ledger
      as ``InvalidVirtualKeyError``), and the folded accept+reserve round trip
      (``gateway_accept_and_start_attempt``) moves the unkeyed hot path's
      accept-time gate to this same seam. Re-raised as the typed
      ``DispatchKeyRevokedError``: an ``AttemptRejectedError`` the executor
      propagates unchanged without latching, mapped by the shared boundary to
      the same uniform 401 as every other revoked-key rejection — no request
      ever serves or charges on a revoked key, and the status no longer
      degrades to the imprecise 429 for the in-flight race.
    - A pre-dispatch ledger invariant (``GatewayLedgerError``: snapshot/model
      mismatch, an out-of-range reserved cost, or an int-P1 invariant SQLSTATE).
      Mapped to a deployment-scope ``BudgetReservationRejected`` so the
      waterfall skips this route — a healthy fallback rung can still serve —
      and, when every rung is exhausted, the request ends as Experiential's
      ``all_routes_unavailable`` (PROVIDER_INTERNAL). It is logged loudly so a
      real inconsistency stays visible instead of silently degrading.

    Both cases avoid Experiential's latch through its typed escapes; a plain
    (non-ledger) ``start_attempt`` exception is a genuine infrastructure or
    programming failure and passes through untouched so the latch still fires.

    Accept-time rejections for KEYED requests are untouched: their
    ``accept_request`` persists outside the executor, so its
    ``InvalidVirtualKeyError`` already maps to a uniform 401 without touching
    the latch, and the idempotency 409s (P1020/P1021) keep their surface. An
    UNKEYED request defers its accept into the combined reservation call, so
    every accept-time SQLSTATE it can raise surfaces here instead.
    """

    def __init__(self, ledger: AttemptLedger) -> None:
        """Wrap one durable attempt ledger."""
        self._ledger = ledger

    async def accept_request(self, *, authorization: AuthorizationSnapshot) -> None:
        """Persist one accepted request (auth failures here map to 401)."""
        await self._ledger.accept_request(authorization=authorization)

    async def start_attempt(
        self,
        *,
        snapshot: ExecutionSnapshot,
        deployment: ExactModelDeployment,
        attempt_ordinal: int,
        route_depth: int,
        maximum_cost_micro_usd: int | None = None,
        route_reason: str | None = None,
        fallback_reason: str | None = None,
    ) -> AttemptId:
        """Reserve and persist one attempt, shielding pre-dispatch failures."""
        try:
            return await self._ledger.start_attempt(
                snapshot=snapshot,
                deployment=deployment,
                attempt_ordinal=attempt_ordinal,
                route_depth=route_depth,
                maximum_cost_micro_usd=maximum_cost_micro_usd,
                route_reason=route_reason,
                fallback_reason=fallback_reason,
            )
        except InvalidVirtualKeyError as exc:
            # Typed, non-latching, boundary-mapped to the uniform 401 (see
            # DispatchKeyRevokedError). The revoked key never serves or charges.
            raise DispatchKeyRevokedError(str(exc)) from exc
        except GatewayLedgerError as exc:
            # Pre-dispatch, transactional: no attempt reserved, nothing durable
            # written. Skip this route (deployment scope) instead of latching
            # the worker unhealthy for every org over one attempt's invariant.
            logger.exception(
                "gateway start_attempt ledger invariant; skipping route without "
                "latching worker health"
            )
            raise BudgetReservationRejected(
                scope_kind=BudgetScopeKind.DEPLOYMENT,
                reason=str(exc),
            ) from exc

    async def finish_attempt(
        self,
        *,
        attempt_id: AttemptId,
        terminal_event: GatewayEvent | None,
        failure: GatewayFailure | None,
        finalize_request: bool = True,
        first_token_at: datetime | None = None,
    ) -> None:
        """Settle one physical attempt."""
        await self._ledger.finish_attempt(
            attempt_id=attempt_id,
            terminal_event=terminal_event,
            failure=failure,
            finalize_request=finalize_request,
            first_token_at=first_token_at,
        )

    async def finish_request(
        self,
        *,
        authorization: AuthorizationSnapshot,
        failure: GatewayFailure,
    ) -> None:
        """Terminalize accepted work that failed before any dispatch."""
        await self._ledger.finish_request(authorization=authorization, failure=failure)

    def observe_first_token(self, *, request_id: str) -> None:
        """Forward a seam-observed first token to a ledger that records them.

        The exp ``AttemptLedger`` protocol carries no observation seam, so the
        forward is duck-typed: ledgers without it (test doubles that assert on
        plane-emitted values only) are silently skipped.
        """
        observer = getattr(self._ledger, "observe_first_token", None)
        if observer is not None:
            observer(request_id=request_id)


# The outward event kinds that count as a request's first token, mirroring the
# semantic set Experiential's executor itself uses to stamp first_token_at.
_FIRST_TOKEN_EVENTS = frozenset(
    {
        GatewayEventKind.TEXT_DELTA,
        GatewayEventKind.REFUSAL_DELTA,
        GatewayEventKind.TOOL_CALL_STARTED,
        GatewayEventKind.TOOL_ARGUMENTS_DELTA,
        GatewayEventKind.TOOL_CALL_COMPLETED,
    }
)


class _FirstTokenObservingStream:
    """Delegating execution stream that stamps the first outward semantic event.

    The Python plane already reports ``first_token_at`` at settlement; this seam
    exists so TTFT still populates when a serving plane omits it (the emitted
    value always wins — see ``PostgresAttemptLedger._resolve_first_token``).
    Only iteration is intercepted; everything else (``abort``, ``cancel``,
    ``deployment``, ``route_depth``) delegates to the wrapped stream.
    """

    def __init__(self, inner: GatewayExecutionStream, on_first_token: Callable[[], None]) -> None:
        self._inner = inner
        self._on_first_token = on_first_token
        self._observed = False

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)

    def __aiter__(self) -> _FirstTokenObservingStream:
        return self

    async def __anext__(self) -> GatewayEvent:
        event = await self._inner.__anext__()
        if not self._observed and event.kind in _FIRST_TOKEN_EVENTS:
            self._observed = True
            self._on_first_token()
        return event


class RefreshingGatewayExecutor:
    """Recompose Experiential's executor per catalog generation without losing health.

    Experiential's ``GatewayExecutor`` copies its catalogs mapping at construction, so
    every catalog swap needs a fresh executor over ``state.runtime_catalogs``.
    Two pieces of state must outlive any one generation:

    - the deployment circuit/throttle registry, shared across generations so a
      swap cannot reset an open circuit; and
    - the accounting-healthy latch: an in-flight stream settles against ITS
      generation's executor, so retired executors are probed for a bounded
      window and any latched failure is carried forward permanently.

    Admission is per-generation (each executor owns its semaphore), so during
    a swap the worker may briefly admit up to one extra generation's worth of
    requests; the bound stays finite and the drain path is unaffected.
    """

    def __init__(
        self,
        catalog: CatalogSource,
        ledger: AttemptLedger,
        *,
        maximum_active_requests: int = 64,
        retired_probe_seconds: float = 120.0 + _RETIRED_EXECUTOR_PROBE_MARGIN_SECONDS,
        monotonic: Callable[[], float] | None = None,
    ) -> None:
        """Bind the live catalog source and the shared attempt ledger.

        Args:
            catalog: Live catalog source; each dispatch reads its state once.
            ledger: Durable content-free attempt accounting.
            maximum_active_requests: Per-generation admission bound.
            retired_probe_seconds: How long a retired generation stays probed
                for the accounting latch; must exceed the request timeout.
            monotonic: Injectable monotonic clock for retirement windows.
        """
        self._catalog = catalog
        self._ledger = ledger
        self._maximum_active_requests = maximum_active_requests
        self._retired_probe_seconds = retired_probe_seconds
        self._monotonic = monotonic if monotonic is not None else time.monotonic
        self._health = DeploymentHealthRegistry()
        self._lock = threading.Lock()
        self._unhealthy = False
        self._current_state: GatewayCatalogState | None = None
        self._current: GatewayExecutor | None = None
        self._retired: list[tuple[GatewayExecutor, float]] = []

    def _generation(self) -> GatewayExecutor:
        """Return the executor for the current catalog state, recomposing on swap."""
        state = self._catalog.state
        with self._lock:
            if self._current is not None and self._current_state is state:
                return self._current
            if self._current is not None:
                self._retired.append((self._current, self._monotonic()))
            executor = GatewayExecutor(
                state.runtime_catalogs,
                self._ledger,
                maximum_active_requests=self._maximum_active_requests,
                health=self._health,
            )
            self._current = executor
            self._current_state = state
            return executor

    def _sweep_retired(self) -> None:
        """Carry any retired generation's latched failure, then prune old ones."""
        now = self._monotonic()
        with self._lock:
            kept: list[tuple[GatewayExecutor, float]] = []
            for executor, retired_at in self._retired:
                try:
                    executor.require_healthy()
                except GatewayExecutionError:
                    self._unhealthy = True
                    continue
                if now - retired_at < self._retired_probe_seconds:
                    kept.append((executor, retired_at))
            self._retired = kept

    def accounting_healthy(self) -> bool:
        """Whether no generation has ever lost a terminal accounting write."""
        self._sweep_retired()
        with self._lock:
            if self._unhealthy:
                return False
            current = self._current
        if current is None:
            return True
        try:
            current.require_healthy()
        except GatewayExecutionError:
            return False
        return True

    def require_healthy(self) -> None:
        """Fail preflight once any generation lost a terminal accounting write."""
        if not self.accounting_healthy():
            raise GatewayExecutionError(
                GatewayFailure(
                    failure_class=GatewayFailureClass.INTERNAL,
                    safe_message="gateway terminal accounting is unhealthy",
                )
            )

    def mark_accounting_unhealthy(self) -> None:
        """Latch an unhealthy state across every current and future generation."""
        with self._lock:
            self._unhealthy = True

    async def start(
        self,
        *,
        route: GatewayRoute,
        request: GatewayRequest,
    ) -> GatewayExecutionStream:
        """Dispatch one route on the current generation's executor.

        The returned stream is wrapped to stamp the request's first outward
        semantic event on the ledger, so TTFT populates even when the serving
        plane omits ``first_token_at`` at settlement (emitted values win).
        """
        stream = await self._generation().start(route=route, request=request)
        request_id = route.snapshot.authorization.request_id
        observer = getattr(self._ledger, "observe_first_token", None)
        if observer is None:
            return stream
        return cast(
            "GatewayExecutionStream",
            _FirstTokenObservingStream(stream, lambda: observer(request_id=request_id)),
        )


def catalog_readiness_probe(
    catalog: CatalogSource,
    clock: GatewayClock,
) -> Callable[[], Awaitable[ExecutionSnapshot]]:
    """Build a credential-free proof that one active alias can route.

    Mirrors Experiential's direct-alias readiness: pick one activated alias plan from
    the current catalog build, verify its pool exists in the normalized
    snapshot, and freeze a synthetic authorization for it. No provider work,
    no credentials, no database round trip.

    Args:
        catalog: Live catalog source.
        clock: Deadline clock for the synthetic authorization.

    Returns:
        The awaitable readiness probe ``GatewayService`` requires.
    """

    async def probe() -> ExecutionSnapshot:
        state = catalog.state
        build = state.build
        if build.normalized is None or build.catalog_sha256 is None or not build.alias_plans:
            msg = "gateway catalog is empty; no granted alias can route"
            raise GatewayWorkerError(msg)
        plan = build.alias_plans[0]
        pool = next(
            (item for item in build.normalized.pools if item.pool_id == plan.target.pool_id),
            None,
        )
        if pool is None:
            msg = f"alias {plan.alias_name!r} names a pool missing from its snapshot"
            raise GatewayWorkerError(msg)
        authorization = AuthorizationSnapshot(
            request_id="gateway-worker-readiness-probe",
            organization_id="org-gateway-readiness",
            identity_id="identity-gateway-readiness",
            virtual_key_id="key-gateway-readiness",
            alias=plan.alias_name,
            alias_revision_id=plan.revision_id,
            target=DirectTarget(pool_id=pool.pool_id),
            surface=GatewayApiSurface.CHAT_COMPLETIONS,
            catalog_sha256=plan.catalog_sha256,
            canonical_request_sha256="0" * 64,
            deadline_monotonic=clock.monotonic() + 30.0,
        )
        return ExecutionSnapshot(
            authorization=authorization,
            exact_model_id=pool.exact_model_id,
            pool_id=pool.pool_id,
            deployment_ids=pool.deployment_ids,
        )

    return probe


class WorkerPresence:
    """Maintain the ``gateway_workers`` row plus the probe readiness marker.

    Mirrors the Project worker's presence discipline: the first heartbeat
    publishes before the marker exists, refresh failures only age the marker
    out, and exit publishes ``dead`` and removes the marker.
    """

    def __init__(
        self,
        db: GatewayDatabase,
        settings: GatewayWorkerSettings,
        *,
        phase: Callable[[], GatewayWorkerPhase],
        catalog_sha256: Callable[[], str | None],
    ) -> None:
        """Bind the pooled database and the live phase/catalog suppliers."""
        self._db = db
        self._settings = settings
        self._phase = phase
        self._catalog_sha256 = catalog_sha256
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="gateway-worker-presence",
            daemon=True,
        )

    def start(self) -> None:
        """Publish the first heartbeat before becoming probe-ready."""
        self.heartbeat()
        self._thread.start()

    def stop(self) -> None:
        """Publish the terminal ``dead`` state and withdraw probe readiness."""
        self._stop.set()
        self._thread.join(timeout=max(self._settings.heartbeat_seconds * 2, 1.0))
        try:
            self._publish(GatewayWorkerPhase.DEAD)
        except Exception:  # noqa: BLE001 - heartbeat staleness still marks the worker dead
            logger.warning("Could not publish the dead gateway worker state", exc_info=True)
        Path(self._settings.ready_file).unlink(missing_ok=True)

    def heartbeat(self) -> None:
        """Refresh DB presence and atomically refresh the readiness marker mtime."""
        self._publish(self._phase())
        ready_file = Path(self._settings.ready_file)
        ready_file.parent.mkdir(parents=True, exist_ok=True)
        ready_file.touch()

    def _publish(self, phase: GatewayWorkerPhase) -> None:
        """Upsert this worker's row through the sanctioned SQL write path."""
        with self._db.transaction() as cursor:
            cursor.execute(
                "select public.gateway_worker_heartbeat(%s, %s, %s, %s)",
                (
                    self._settings.worker_id,
                    phase.value,
                    self._catalog_sha256(),
                    self._settings.app_version,
                ),
            )

    def _run(self) -> None:
        """Refresh presence until shutdown; failed probes age out naturally."""
        while not self._stop.wait(self._settings.heartbeat_seconds):
            try:
                self.heartbeat()
            except Exception:  # noqa: BLE001 - probe fails once the marker becomes stale
                logger.warning("Gateway worker presence heartbeat failed", exc_info=True)


class CrashReconciler:
    """Invoke ``gateway_reconcile_crashed`` on a fixed cadence, NEVER at boot.

    Every worker runs this loop: the SQL function's advisory transaction lock
    serializes concurrent invocations, so election is unnecessary. The first
    invocation happens one full interval after ``start`` — a restarting worker
    must never reconcile while its siblings' (or its own surviving) attempts
    are still live.
    """

    def __init__(self, db: GatewayDatabase, settings: GatewayWorkerSettings) -> None:
        """Bind the pooled database and reconcile cadence."""
        self._db = db
        self._settings = settings
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name="gateway-crash-reconciler",
            daemon=True,
        )

    def start(self) -> None:
        """Start the loop; the first pass runs one interval from now."""
        self._thread.start()

    def stop(self) -> None:
        """Stop the loop and wait for it to exit."""
        self._stop.set()
        self._thread.join(timeout=max(self._settings.reconcile_interval_seconds, 1.0))

    def _run(self) -> None:
        """Sleep one interval first, then reconcile until stopped."""
        while not self._stop.wait(self._settings.reconcile_interval_seconds):
            try:
                self.reconcile_once()
            except Exception:  # noqa: BLE001 - the next pass retries; workers stay up
                logger.warning("Gateway crash reconciliation pass failed", exc_info=True)

    def reconcile_once(self) -> tuple[int, int]:
        """Run one reconcile pass and return (expired requests, unknown attempts)."""
        with self._db.transaction() as cursor:
            cursor.execute(
                "select expired_requests, unknown_attempts"
                " from public.gateway_reconcile_crashed(p_grace_seconds => %s)",
                (self._settings.reconcile_grace_seconds,),
            )
            row = cursor.fetchone()
        if row is None:
            msg = "gateway_reconcile_crashed returned no row"
            raise GatewayWorkerError(msg)
        expired, unknown = int(str(row[0])), int(str(row[1]))
        if expired or unknown:
            logger.info(
                "Gateway crash reconciliation settled orphans",
                extra={"expired_requests": expired, "unknown_attempts": unknown},
            )
        return expired, unknown


def ping_database(database_url: str) -> bool:
    """Prove Postgres is reachable with one short-lived connection.

    Deliberately NOT the worker pool: a wedged pool must not mask an
    unreachable database, and a fresh connect proves the full path.

    Args:
        database_url: The worker's ``SUPABASE_DB_URL``.

    Returns:
        Whether one ``select 1`` round trip succeeded.
    """
    try:
        with psycopg.connect(
            database_url, connect_timeout=_READY_PING_CONNECT_TIMEOUT_SECONDS
        ) as connection:
            connection.execute("select 1")
    except psycopg.Error:
        return False
    return True


@dataclass
class GatewayWorkerRuntime:
    """Everything one worker process owns, composed once and injected into the app."""

    settings: GatewayWorkerSettings
    db: GatewayDatabase
    catalog: CatalogSource
    executor: RefreshingGatewayExecutor
    service: GatewayService
    presence: WorkerPresence
    reconciler: CrashReconciler
    ping: Callable[[], bool]
    continuations: PostgresContinuationStore | None = None
    native_components: HostedNativeGatewayComponents | None = None
    # Settled-cost handoff from the ledger to the response annotator; None
    # only in tests that compose a runtime without the annotation seam.
    cost_registry: CostRegistry | None = None
    _phase: GatewayWorkerPhase = field(default=GatewayWorkerPhase.STARTING, init=False)
    _phase_lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _drain_task: asyncio.Task[bool] | None = field(default=None, init=False, repr=False)

    @property
    def phase(self) -> GatewayWorkerPhase:
        """The worker's current lifecycle phase."""
        with self._phase_lock:
            return self._phase

    def _set_phase(self, phase: GatewayWorkerPhase) -> None:
        """Advance the lifecycle phase (drain and death never regress)."""
        with self._phase_lock:
            if self._phase in {GatewayWorkerPhase.DRAINING, GatewayWorkerPhase.DEAD} and phase in {
                GatewayWorkerPhase.STARTING,
                GatewayWorkerPhase.READY,
            }:
                return
            self._phase = phase

    def catalog_sha256(self) -> str | None:
        """The current catalog digest for heartbeats (None before first build)."""
        if not self.catalog.loaded:
            return None
        return self.catalog.state.build.catalog_sha256

    async def startup(self) -> None:
        """Publish presence, build the first catalog, and start the loops.

        Idempotent: a runtime that already reached READY returns immediately,
        so the native path can complete startup BEFORE entering Experiential's
        server (whose embedded-fallback window is far shorter than a
        production catalog build) and the fallback app's lifespan re-entry
        becomes a no-op instead of a second presence/build/loop start.

        Every startup DB touch is bounded (the pool and the catalog refresher's
        connect factory carry a connect timeout), so an unreachable database
        fails this method in seconds instead of hanging before uvicorn binds.
        The psycopg error is logged here so the next hosted attempt surfaces the
        real reachability failure in the pod logs.

        Raises:
            psycopg.Error: Postgres is unreachable or the first build failed;
                startup fails loudly rather than serving with no swap-in path.
        """
        if self.phase is GatewayWorkerPhase.READY:
            return
        try:
            await asyncio.to_thread(self.presence.start)
            # The first build must succeed (an empty catalog builds
            # successfully); failing startup loudly beats serving with no
            # swap-in path.
            await asyncio.to_thread(self.catalog.refresh_now)
        except psycopg.Error:
            # PoolTimeout subclasses psycopg.Error, so a wedged pool is covered.
            logger.exception("Gateway worker startup could not reach Postgres; failing fast")
            raise
        self.catalog.start()
        self.reconciler.start()
        self._set_phase(GatewayWorkerPhase.READY)

    async def shutdown(self) -> None:
        """Drain owned work, stop the loops, and publish the dead heartbeat."""
        # SIGTERM path: uvicorn has already waited for open connections, so
        # this drain normally returns immediately; the bound only protects
        # the terminal accounting flush.
        await self.drain(timeout_seconds=min(30.0, self.settings.drain_timeout_seconds))
        self.catalog.stop()
        self.reconciler.stop()
        await asyncio.to_thread(self.presence.stop)
        self.db.close()

    async def drain(self, *, timeout_seconds: float | None = None) -> bool:
        """Stop admission once and drain in-flight work within a finite bound.

        Concurrent callers await the same single drain; the phase flips to
        ``draining`` immediately so readiness and heartbeats report it.

        Args:
            timeout_seconds: Graceful bound; defaults to the configured drain
                timeout.

        Returns:
            Whether every in-flight request finished gracefully.
        """
        bound = self.settings.drain_timeout_seconds if timeout_seconds is None else timeout_seconds
        self._set_phase(GatewayWorkerPhase.DRAINING)
        task = self._drain_task
        if task is None:
            task = asyncio.create_task(self.service.drain(timeout_seconds=bound))
            self._drain_task = task
        if task.done():
            return task.result()
        return await asyncio.shield(task)

    async def ready_checks(self) -> dict[str, bool]:
        """Evaluate every readiness condition without caching any of them."""
        return {
            "database": await asyncio.to_thread(self.ping),
            "catalog": self.catalog.loaded,
            "accounting": self.executor.accounting_healthy(),
            "admitting": self.phase is GatewayWorkerPhase.READY,
        }

    def native_ready(self) -> bool:
        """Return hosted readiness synchronously for Rust callback threads."""
        return (
            self.ping()
            and self.catalog.loaded
            and self.executor.accounting_healthy()
            and self.phase is GatewayWorkerPhase.READY
        )


def compose_gateway_worker_runtime(settings: GatewayWorkerSettings) -> GatewayWorkerRuntime:
    """Wire the production worker from the P1/P2/P3 parts without any I/O.

    Construction never touches the network: the pool opens lazily, the
    catalog refresher builds on ``startup``, and presence publishes its first
    heartbeat inside the application lifespan.

    Args:
        settings: Validated deployment settings.

    Returns:
        The runtime the outer application owns.
    """
    db = GatewayDatabase(settings.database_url)
    clock: GatewayClock = SystemGatewayClock()
    # One shared lineage tracker: authorize computes content-free prompt and
    # conversation digests, whichever ledger call durably persists the accept
    # writes them (explabs/gateway/lineage.py).
    lineage = RequestLineageTracker()
    # Opt-in prompt capture rides the same authorize->accept handoff: content
    # is buffered only for capture-on orgs and persisted by a background
    # writer (explabs/gateway/capture.py).
    capture_buffer = PromptCaptureBuffer()
    capture_writer = PromptCaptureWriter(db)
    control_store: GatewayControlStore = PostgresGatewayControlStore(
        db, clock=clock, lineage=lineage, capture=capture_buffer
    )
    # Measure-only: the shadow rides the reservation seam and its refresher
    # reads existing budget truth off the hot path; nothing enforces from it.
    lease_shadow = (
        LeaseShadow(PostgresLeaseStateReader(db)) if settings.lease_shadow_enabled else None
    )
    # Settled billing outcomes ride from the finalizing settle to the response
    # annotator, which stamps the additive usage.cost on /v1 completions.
    cost_registry = CostRegistry()
    postgres_ledger = PostgresAttemptLedger(
        db,
        clock=clock,
        lease_shadow=lease_shadow,
        lineage=lineage,
        capture_buffer=capture_buffer,
        capture_writer=capture_writer,
        cost_registry=cost_registry,
    )
    ledger: AttemptLedger = DispatchLatchShield(postgres_ledger)
    catalog = GatewayCatalogRefresher(
        lambda: psycopg.connect(
            settings.database_url,
            connect_timeout=_STARTUP_CONNECT_TIMEOUT_SECONDS,
            # Supavisor transaction mode does not preserve one server session
            # behind this client, so automatic prepared statements are unsafe.
            prepare_threshold=None,
        ),
    )
    executor = RefreshingGatewayExecutor(
        catalog,
        ledger,
        maximum_active_requests=settings.maximum_active_requests,
        retired_probe_seconds=settings.request_timeout_seconds
        + _RETIRED_EXECUTOR_PROBE_MARGIN_SECONDS,
    )

    # Named closures so presence heartbeats read the runtime constructed below;
    # the first heartbeat only fires inside the application lifespan.
    def current_phase() -> GatewayWorkerPhase:
        return runtime.phase

    def current_catalog_sha256() -> str | None:
        return runtime.catalog_sha256()

    routes = OrgAwareRouteResolver(catalog)
    continuations = PostgresContinuationStore(db)
    service = GatewayService(
        control_store=control_store,
        ledger=ledger,
        # GatewayService annotates the concrete resolver and executor classes
        # rather than Protocols; both adapters implement the exact call
        # surface the service uses (upstream seam request filed).
        routes=cast("CatalogRouteResolver", routes),
        executor=cast("GatewayExecutor", executor),
        clock=clock,
        readiness_probe=catalog_readiness_probe(catalog, clock),
        request_timeout_seconds=settings.request_timeout_seconds,
        replay_store=PostgresReplayStore(db),
        continuation_store=continuations,
    )
    runtime = GatewayWorkerRuntime(
        settings=settings,
        db=db,
        catalog=catalog,
        executor=executor,
        service=service,
        presence=WorkerPresence(
            db,
            settings,
            phase=current_phase,
            catalog_sha256=current_catalog_sha256,
        ),
        reconciler=CrashReconciler(db, settings),
        ping=lambda: ping_database(settings.database_url),
        continuations=continuations,
        cost_registry=cost_registry,
        native_components=HostedNativeGatewayComponents(
            store=control_store,
            ledger=postgres_ledger,
            routes=routes,
            executor=executor,
            catalog=catalog,
        ),
    )
    return runtime


def _scope_bearer(scope: dict[str, object]) -> str | None:
    """Extract a non-empty Bearer credential from an ASGI HTTP scope."""
    headers = scope.get("headers")
    if not isinstance(headers, list):
        return None
    for name, value in cast("list[tuple[bytes, bytes]]", headers):
        if name == b"authorization":
            decoded = value.decode("latin-1")
            if decoded.lower().startswith("bearer "):
                credential = decoded[len("bearer ") :].strip()
                return credential or None
    return None


def _headers_with_content_length(
    headers: list[tuple[bytes, bytes]], length: int
) -> list[tuple[bytes, bytes]]:
    """Return the header list with content-length replaced by ``length``."""
    kept = [(name, value) for name, value in headers if name.lower() != b"content-length"]
    kept.append((b"content-length", str(length).encode()))
    return kept


class EmailVerificationQuotaMiddleware:
    """Restore actionable messages on a spend-gated / promo-exhausted 429.

    exp collapses both the P1025 email-verification refusal and the P1030
    promo->credits transition to a generic ``insufficient_quota`` 429 (see
    :mod:`explabs.gateway.verification_notice` and
    :mod:`explabs.gateway.promo_notice`). This ASGI middleware rewrites that one
    response for the OpenAI ``/v1`` lane — chat completions, and the playground
    that relays its message — checking the more specific promo transition first
    (its fresh notice row names the model) and the unverified-org gate second.
    ``/v1/messages`` is skipped because the Anthropic adapter enriches its own
    error envelope before translating it. Only 429 responses are buffered, so
    streaming 200 completions pass through untouched.
    """

    def __init__(self, app: object, *, db: GatewayDatabase) -> None:
        """Wrap the downstream ASGI app and bind the worker's connection pool."""
        self._app = app
        self._db = db

    async def __call__(
        self,
        scope: dict[str, object],
        receive: Callable[[], Awaitable[object]],
        send: Callable[[object], Awaitable[None]],
    ) -> None:
        """Buffer a 429 to rewrite its quota message; pass everything else through."""
        app = cast("Callable[..., Awaitable[None]]", self._app)
        if scope.get("type") != "http" or scope.get("path") == "/v1/messages":
            await app(scope, receive, send)
            return
        raw_key = _scope_bearer(scope)
        if raw_key is None:
            await app(scope, receive, send)
            return

        start_message: dict[str, object] = {}
        chunks: list[bytes] = []
        state = {"intercept": False}

        async def send_wrapper(raw_message: object) -> None:
            if not isinstance(raw_message, dict):
                await send(raw_message)
                return
            message = cast("dict[str, object]", raw_message)
            if message.get("type") == "http.response.start":
                if message.get("status") == 429:
                    state["intercept"] = True
                    start_message.update(message)
                    return
                await send(message)
                return
            if message.get("type") == "http.response.body" and state["intercept"]:
                body = message.get("body", b"")
                chunks.append(body if isinstance(body, bytes) else b"")
                if message.get("more_body"):
                    return
                new_body = await self._rewrite(raw_key, b"".join(chunks))
                raw_headers = start_message.get("headers", [])
                headers = _headers_with_content_length(
                    cast("list[tuple[bytes, bytes]]", raw_headers), len(new_body)
                )
                await send(
                    {
                        "type": "http.response.start",
                        "status": start_message.get("status", 429),
                        "headers": headers,
                    }
                )
                await send({"type": "http.response.body", "body": new_body})
                return
            await send(message)

        await app(scope, receive, send_wrapper)

    async def _rewrite(self, raw_key: str, body: bytes) -> bytes:
        """Rewrite an insufficient-quota body for an unverified org, else pass it."""
        try:
            parsed = json.loads(body)
        except ValueError:
            return body
        if not is_insufficient_quota_envelope(parsed):
            return body
        # Promo->credits transition is more specific than the verify-email gate
        # (an unverified org can also exhaust a promo); check it first. The fresh
        # notice row the ledger just wrote for this refusal identifies the
        # promotion (scoped promotions span models, so the label names it).
        promo_label = await asyncio.to_thread(promo_exhausted_label_for_key, self._db, raw_key)
        if promo_label is not None:
            return json.dumps(apply_promo_exhausted_notice(parsed, promo_label)).encode()
        unverified = await asyncio.to_thread(org_owner_unverified_for_key, self._db, raw_key)
        if not unverified:
            return body
        return json.dumps(apply_verify_email_notice(parsed)).encode()


def create_gateway_worker_app(
    settings: GatewayWorkerSettings | None = None,
    *,
    runtime: GatewayWorkerRuntime | None = None,
) -> FastAPI:
    """Create the worker's outer application with Experiential's data plane mounted.

    Args:
        settings: Deployment settings; read from the environment when omitted.
        runtime: Pre-composed runtime override for tests.

    Returns:
        The outer FastAPI app: worker health, authenticated drain, and Experiential's
        ``/v1`` OpenAI-compatible surface.
    """
    if runtime is None:
        runtime = compose_gateway_worker_runtime(
            settings if settings is not None else GatewayWorkerSettings.from_env()
        )
    owned = runtime

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        """Own presence, catalog, and reconcile loops for the app lifetime."""
        await owned.startup()
        try:
            yield
        finally:
            await owned.shutdown()

    app = FastAPI(title="Experiential Labs gateway worker", lifespan=lifespan)
    app.state.gateway_worker_runtime = owned

    @app.get("/health/live")
    async def health_live() -> JSONResponse:
        """Return liveness as soon as the ASGI listener reaches this worker."""
        return JSONResponse({"status": "live"})

    @app.get("/health/ready")
    async def health_ready() -> JSONResponse:
        """Return readiness from live checks: database, catalog, accounting."""
        checks = await owned.ready_checks()
        ready = all(checks.values())
        return JSONResponse(
            {"status": "ready" if ready else "not_ready", "checks": checks},
            status_code=200 if ready else 503,
        )

    @app.post("/internal/drain")
    async def internal_drain(
        authorization: Annotated[str | None, Header()] = None,
    ) -> JSONResponse:
        """Drain this worker; deployment-key bearer only."""
        provided = _bearer_credential(authorization)
        if provided is None or not secrets.compare_digest(provided, owned.settings.drain_key):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        graceful = await owned.drain()
        return JSONResponse({"graceful": graceful, "state": owned.phase.value})

    # The Anthropic Messages adapter must register before the root mount: the
    # mount is a catch-all, and any route added after it is unreachable.
    register_messages_route(app, owned.service, owned.db)
    app.mount("/", create_gateway_app(owned.service))
    # Innermost /v1 decoration: settled usage.cost on completion responses
    # (cost_annotation.py). The exp mount keeps protocol ownership; this
    # rewrites finished 200 payloads. The models-listing pricing extension
    # needs no middleware — it publishes through the resolver seam
    # (OrgAwareRouteResolver.published_metadata), which covers the Rust
    # plane's native /v1/models callback as well.
    if owned.cost_registry is not None:
        app.add_middleware(UsageCostAnnotator, registry=owned.cost_registry)
    # Rewrites the generic insufficient_quota 429 into the verify-your-email
    # message for the OpenAI /v1 lane when the org's founding admin is unverified
    # (the Anthropic lane does its own enrichment inside the adapter). Added
    # before the timing middleware so the timing line (outermost) still covers
    # the rewrite.
    app.add_middleware(EmailVerificationQuotaMiddleware, db=owned.db)

    # Imported lazily: ``explabs.api.app`` composes its module-level app at
    # import time and, under EXPLABS_GATEWAY_WORKER_ONLY, that composition
    # imports THIS module — a top-level import here would recurse. In the
    # hosted path (create_app -> here) the module is already loaded, so this
    # resolves from sys.modules.
    from explabs.api.request_timing import RequestTimingMiddleware

    # Outermost so the timing line covers routing plus the full streamed /v1
    # relay. The worker never stamps a deployment credential, so the header
    # policy is the fixed setting, not the api pod's per-request gate.
    app.add_middleware(
        RequestTimingMiddleware, timing_header_enabled=owned.settings.timing_header_enabled
    )
    return app


def _bearer_credential(authorization: str | None) -> str | None:
    """Extract one non-empty Bearer credential without logging it."""
    if authorization is None:
        return None
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() == "bearer" and credential.strip():
        return credential.strip()
    return None


def _native_route_eligible(route: GatewayRoute, request: GatewayRequest) -> bool:
    """Return whether Platform can preserve this request's semantics in Rust.

    Args:
        route: Resolved direct route.
        request: Canonical caller request.

    Returns:
        True for unkeyed customer-managed requests. Platform-funded retry
        insurance and cross-worker keyed replay remain on the shared Python
        execution path.
    """
    return (
        route.deployment.billing_source.value == "customer_managed"
        and request.idempotency_key is None
        and request.client_request_id is None
    )


def _data_plane_metrics() -> Callable[[], str] | None:
    """Return the native engine's content-free metrics snapshot provider.

    The compiled `exp_gateway_native` extension owns the Rust data plane's
    atomic metrics registry. Passing its snapshot callback into the control
    plane fills the snapshot's `data_plane` section, which the hosted worker
    otherwise reports as null.

    Returns:
        `exp_gateway_native.metrics_snapshot_json` when the extension is
        installed, otherwise None so composition still succeeds where only
        the pure-Python fallback is available.
    """
    try:
        native = importlib.import_module("exp_gateway_native")
    except ImportError:
        logger.warning("exp_gateway_native is not importable; data-plane metrics stay empty")
        return None
    return cast("Callable[[], str]", native.metrics_snapshot_json)


def main() -> None:
    """Run Experiential's Rust gateway with the hosted Python fallback."""
    # The worker process configures no other logging; without a root handler
    # every logger.exception in this module is silently dropped and a dying
    # pod's real failure never reaches the pod logs (only unhandled
    # tracebacks do). No-op when a handler is already installed.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    settings = GatewayWorkerSettings.from_env()
    runtime = compose_gateway_worker_runtime(settings)
    app = create_gateway_worker_app(runtime=runtime)
    # Complete the worker's own startup (presence, FIRST CATALOG BUILD, and
    # the background loops) BEFORE entering Experiential's native server: the
    # server allows its embedded Python fallback only ~30 seconds to come up,
    # while a production catalog build alone approaches that from a fast
    # machine and exceeds it inside a pod — the fallback lifespan (which runs
    # this same startup) then times out and the pod dies in a crashloop as
    # "the embedded Python fallback failed to start", masking the real cause.
    # startup() is idempotent, so the lifespan re-entry is a no-op and the
    # fallback binds in milliseconds; any genuine startup failure is logged
    # here with its traceback before the process exits.
    try:
        asyncio.run(runtime.startup())
    except BaseException:
        logger.exception("gateway worker startup failed before the native plane came up")
        raise
    components = runtime.native_components
    continuations = runtime.continuations
    if components is None or continuations is None:  # pragma: no cover - production invariant
        message = "native gateway components are unavailable"
        raise GatewayWorkerError(message)
    control_plane = NativeControlPlane(
        cast("NativeGatewayComponents", components),
        request_timeout_seconds=settings.request_timeout_seconds,
        continuation_store=cast("BoundedContinuationStore", continuations),
        data_plane_metrics=_data_plane_metrics(),
        readiness_probe=runtime.native_ready,
        budget_error_factory=lambda raw_key: native_budget_error(runtime.db, raw_key),
        # Platform-funded routes retain Python's two-attempt insurance until
        # the native bridge represents every physical retry in the ledger.
        native_route_eligible=_native_route_eligible,
    )
    try:
        serve_native_gateway(
            app,
            control_plane,
            host=args.host,
            port=args.port,
            max_active_requests=settings.maximum_active_requests,
            graceful_timeout_seconds=settings.drain_timeout_seconds,
            # The native local report has a single organization identity. Platform
            # is multi-tenant and retains ownership of any hosted usage surface.
            native_usage_enabled=False,
        )
    except BaseException:
        # The native server wraps fallback and engine failures in its own
        # sanitized error; log the full chain so the pod's real crash reason
        # is in the logs, not just the wrapper.
        logger.exception("the native gateway exited with a failure")
        raise
