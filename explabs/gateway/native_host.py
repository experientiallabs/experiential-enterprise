# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Platform-owned adapters for Experiential's hosted Rust gateway."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol, TypeVar

from exp.common.models.gateway_catalog import ExactModelDeployment
from exp.runtime.gateway.contracts import (
    AttemptId,
    AuthorizationSnapshot,
    ExecutionSnapshot,
    GatewayEvent,
    GatewayFailure,
)
from exp.runtime.gateway.interfaces import GatewayControlStore
from exp.runtime.gateway.native_bridge import NativeBridgeError
from exp.runtime.models import RuntimeModelCatalog
from exp.runtime.openai_protocol.errors import OpenAIProtocolError

from explabs.gateway.catalog import GatewayCatalogState, OrgAwareRouteResolver
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.ledger import PostgresAttemptLedger
from explabs.gateway.verification_notice import (
    VERIFY_EMAIL_CODE,
    VERIFY_EMAIL_MESSAGE,
    org_owner_unverified_for_key,
)

_OperationResult = TypeVar("_OperationResult")


class NativeCatalogSource(Protocol):
    """Live catalog surface required by the native component adapter."""

    @property
    def state(self) -> GatewayCatalogState:
        """Return the current immutable catalog state."""
        ...


class _PostgresNativeApplyCore:
    """The ``core.apply_*`` face Experiential's sync group-commit facade drives.

    Each method mirrors ``SQLiteAttemptLedger.apply_*`` in name and keyword
    shape but maps straight onto the Postgres ledger's blocking bodies. The
    positional ``connection`` slot exists only for signature compatibility:
    SQLite's writer thread passes its batched connection there, while every
    Postgres write is one self-atomic ``gateway_*`` SQL call on the pooled
    database, so the slot is always ``None`` and ignored.
    """

    def __init__(self, ledger: PostgresAttemptLedger) -> None:
        """Bind the Postgres ledger whose blocking bodies back every apply."""
        self._ledger = ledger

    def apply_accept_request(
        self, connection: object, *, authorization: AuthorizationSnapshot
    ) -> None:
        del connection
        self._ledger.accept_request_sync(authorization=authorization)

    def apply_start_attempt(
        self,
        connection: object,
        *,
        snapshot: ExecutionSnapshot,
        deployment: ExactModelDeployment,
        attempt_ordinal: int,
        route_depth: int,
        maximum_cost_micro_usd: int | None = None,
        route_reason: str | None = None,
        fallback_reason: str | None = None,
    ) -> AttemptId:
        del connection
        attempt_id = self._ledger.start_attempt_sync(
            snapshot=snapshot,
            deployment=deployment,
            attempt_ordinal=attempt_ordinal,
            route_depth=route_depth,
            maximum_cost_micro_usd=maximum_cost_micro_usd,
        )
        # Same display-only background write the Python execution path uses.
        if route_reason is not None or fallback_reason is not None:
            self._ledger.record_route_context(
                attempt_id=attempt_id,
                route_reason=route_reason,
                fallback_reason=fallback_reason,
            )
        return attempt_id

    def apply_finish_attempt(
        self,
        connection: object,
        *,
        attempt_id: AttemptId,
        terminal_event: GatewayEvent | None,
        failure: GatewayFailure | None,
        finalize_request: bool = True,
        first_token_at: datetime | None = None,
    ) -> None:
        del connection
        self._ledger.finish_attempt_sync(
            attempt_id=attempt_id,
            terminal_event=terminal_event,
            failure=failure,
            finalize_request=finalize_request,
            first_token_at=first_token_at,
        )

    def apply_finish_request(
        self,
        connection: object,
        *,
        authorization: AuthorizationSnapshot,
        failure: GatewayFailure,
    ) -> None:
        del connection
        self._ledger.finish_request_sync(authorization=authorization, failure=failure)


class PostgresNativeWriteLedger:
    """Group-commit-writer stand-in Experiential's native control plane accepts.

    ``NativeControlPlane`` wraps ``components.write_ledger`` in its
    ``SyncGroupCommitLedger`` facade, which drives exactly two seams:
    ``submit_blocking(operation)`` and ``core.apply_*``. SQLite needs that
    machinery to share one fsync across engines on a single writer thread;
    Postgres does not — each ``gateway_*`` SQL function is durable on its own
    commit — so ``submit_blocking`` runs the operation inline on the calling
    native worker thread (which is exactly a thread without an event loop,
    the case the sync facade exists for) and re-raises its exceptions
    unchanged, preserving the typed budget/authority mapping the bridge's
    handlers rely on.
    """

    def __init__(self, ledger: PostgresAttemptLedger) -> None:
        """Expose the ledger through the ``core`` face the sync facade drives."""
        self.core = _PostgresNativeApplyCore(ledger)

    def submit_blocking(self, operation: Callable[[None], _OperationResult]) -> _OperationResult:
        """Run one ledger operation inline; Postgres needs no batching queue."""
        return operation(None)


@dataclass(frozen=True)
class HostedNativeGatewayComponents:
    """Platform stores and live catalogs consumed by Experiential's Rust bridge."""

    store: GatewayControlStore
    ledger: PostgresAttemptLedger
    routes: OrgAwareRouteResolver
    executor: object
    catalog: NativeCatalogSource
    # The durable write seam the bridge's SyncGroupCommitLedger drives; always
    # derived from the injected ledger (see __post_init__).
    write_ledger: PostgresNativeWriteLedger = field(init=False)
    reconciled_expired_requests: int = 0
    reconciled_unknown_attempts: int = 0

    def __post_init__(self) -> None:
        """Derive the write seam from the injected ledger (frozen dataclass)."""
        object.__setattr__(self, "write_ledger", PostgresNativeWriteLedger(self.ledger))

    @property
    def runtime_catalogs(self) -> Mapping[tuple[str, str], RuntimeModelCatalog]:
        """Return the current immutable catalog generation."""
        return self.catalog.state.runtime_catalogs


def native_budget_error(db: GatewayDatabase, raw_key: str) -> NativeBridgeError:
    """Return the hosted quota error for one rejected native reservation.

    Args:
        db: Worker database used to distinguish the email-verification gate.
        raw_key: Presented virtual key; never logged or persisted here.

    Returns:
        A sanitized quota error preserving Platform's actionable verification policy.
    """
    if org_owner_unverified_for_key(db, raw_key):
        return NativeBridgeError(
            OpenAIProtocolError(
                status_code=429,
                code=VERIFY_EMAIL_CODE,
                message=VERIFY_EMAIL_MESSAGE,
                error_type="insufficient_quota",
            )
        )
    return NativeBridgeError(
        OpenAIProtocolError(
            status_code=429,
            code="insufficient_quota",
            message="monthly gateway allocation is exhausted",
            error_type="insufficient_quota",
        )
    )
