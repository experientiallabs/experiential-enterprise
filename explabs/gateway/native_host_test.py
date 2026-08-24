# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The hosted components satisfy Experiential 0.5.1's native control plane."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import cast
from unittest.mock import MagicMock

from exp.runtime.gateway.contracts import (
    GatewayEvent,
    GatewayEventKind,
    GatewayFailure,
    GatewayFailureClass,
    GatewayUsage,
)
from exp.runtime.gateway.group_commit import GroupCommitAttemptLedger, SyncGroupCommitLedger
from exp.runtime.gateway.native_bridge import NativeControlPlane, NativeGatewayComponents
from psycopg import Cursor
from psycopg.rows import TupleRow

from explabs.gateway.db import GatewayDatabase
from explabs.gateway.ledger import PostgresAttemptLedger
from explabs.gateway.native_host import HostedNativeGatewayComponents

_UNREACHABLE_DSN = "postgresql://nobody@127.0.0.1:1/nowhere"


class _RecordingCursor:
    """Capture executed SQL without touching a real database."""

    def __init__(self, log: list[tuple[str, tuple[object, ...]]]) -> None:
        self._log = log

    def execute(self, sql: str, params: tuple[object, ...] = ()) -> "_RecordingCursor":
        self._log.append((" ".join(sql.split()), params))
        return self


class _RecordingDb(GatewayDatabase):
    """GatewayDatabase double recording the ledger's single-statement calls."""

    def __init__(self) -> None:
        super().__init__(_UNREACHABLE_DSN)
        self.statements: list[tuple[str, tuple[object, ...]]] = []

    @contextmanager
    def atomic_call(self) -> Iterator[Cursor[TupleRow]]:
        yield cast("Cursor[TupleRow]", _RecordingCursor(self.statements))


def _components(ledger: PostgresAttemptLedger | None = None) -> HostedNativeGatewayComponents:
    return HostedNativeGatewayComponents(
        store=MagicMock(),
        ledger=ledger if ledger is not None else MagicMock(),
        routes=MagicMock(),
        executor=MagicMock(),
        catalog=MagicMock(),
    )


def test_native_control_plane_accepts_the_hosted_components() -> None:
    """The 0.5.1 bridge constructs against the platform components.

    Regression pin for the boot crashloop: the bridge's constructor wraps
    ``components.write_ledger`` in its sync group-commit facade, so a
    components object without that seam kills the worker before it binds.
    """
    plane = NativeControlPlane(
        # Same deliberate cast as the production composition in worker.main().
        cast("NativeGatewayComponents", _components()),
        request_timeout_seconds=30,
        continuation_store=MagicMock(),
        readiness_probe=lambda: True,
        budget_error_factory=lambda _raw_key: MagicMock(),
        native_route_eligible=lambda _route, _request: True,
    )
    assert plane is not None


def test_sync_facade_settles_through_the_postgres_ledger() -> None:
    """The bridge's sync facade drives the Postgres settle RPC end to end.

    ``SyncGroupCommitLedger`` calls ``write_ledger.submit_blocking`` with a
    closure over ``write_ledger.core.apply_finish_attempt``; the hosted
    adapter must land that on ``gateway_settle_attempt`` with the emitted
    ``first_token_at`` in the trailing parameter.
    """
    db = _RecordingDb()
    components = _components(PostgresAttemptLedger(db))
    # Same deliberate duck-type as production: the facade drives only
    # submit_blocking + core.apply_*, which the Postgres adapter provides.
    facade = SyncGroupCommitLedger(cast("GroupCommitAttemptLedger", components.write_ledger))
    completed = GatewayEvent(
        kind=GatewayEventKind.COMPLETED,
        sequence_number=1,
        usage=GatewayUsage(input_tokens=2, output_tokens=3),
    )
    facade.finish_attempt(
        attempt_id="attempt-native-1",
        terminal_event=completed,
        failure=None,
        finalize_request=True,
        first_token_at=None,
    )
    sql, params = db.statements[-1]
    assert "gateway_settle_attempt" in sql
    assert params[0] == "attempt-native-1"
    assert len(params) == 12

    facade.finish_request(
        authorization=MagicMock(
            request_id="request-native-1",
            organization_id="org-3f2e4567-e89b-4d3a-8f2e-123456789abc",
        ),
        failure=GatewayFailure(
            failure_class=GatewayFailureClass.INTERNAL,
            safe_message="native admission failed",
        ),
    )
    sql, _params = db.statements[-1]
    assert "gateway_finish_request" in sql
