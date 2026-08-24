# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the audit emit seam: actor derivation, redaction, never-raises."""

from __future__ import annotations

from typing import cast

import pytest

from explabs.api.audit import AuditAction, record_audit_event, redact_snapshot
from explabs.api.tenancy import RequestActor
from explabs.db.repositories import JsonObject, JsonPayload, SupabaseClient


class _RecordedCall:
    """One captured RPC round-trip."""

    def __init__(self, sink: list[tuple[str, JsonObject]], fn: str, params: JsonObject) -> None:
        self._sink = sink
        self._fn = fn
        self._params = params

    def execute(self) -> object:
        """Record the call the way a successful PostgREST round-trip would."""
        self._sink.append((self._fn, self._params))
        return object()


class _RecordingClient:
    """Client stub that captures ``rpc`` payloads without any I/O."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, JsonObject]] = []

    def rpc(self, fn: str, params: JsonPayload | None = None) -> _RecordedCall:
        """Return a query whose execute() records (fn, params)."""
        return _RecordedCall(self.calls, fn, dict(params or {}))


class _FailingClient:
    """Client stub whose RPC execution always fails."""

    def rpc(self, fn: str, params: JsonPayload | None = None) -> object:
        """Return a query whose execute() raises."""
        _ = fn, params

        class _Boom:
            def execute(self) -> object:
                msg = "audit sink unavailable"
                raise RuntimeError(msg)

        return _Boom()


def _emit(
    client: object,
    actor: RequestActor | None,
    *,
    before: JsonObject | None = None,
    after: JsonObject | None = None,
) -> None:
    """Emit one representative event against a stub client."""
    record_audit_event(
        cast("SupabaseClient", client),
        actor=actor,
        org_id="org-1",
        action=AuditAction.PROJECTS_CREATE,
        object_type="project",
        object_id="project-1",
        before=before,
        after=after,
    )


@pytest.mark.parametrize(
    ("actor", "expected_kind", "expected_id"),
    [
        (RequestActor(user_id="user-1", is_platform_admin=False), "user", "user-1"),
        (RequestActor(user_id="op-1", is_platform_admin=True), "platform_admin", "op-1"),
        (
            RequestActor(
                user_id="api-key:org-1",
                is_platform_admin=False,
                api_key_org_id="org-1",
                api_key_id="key-1",
            ),
            "api_key",
            "key-1",
        ),
        (
            RequestActor(user_id="api-key:org-1", is_platform_admin=False, api_key_org_id="org-1"),
            "api_key",
            "org-1",
        ),
        (None, "system", None),
    ],
)
def test_actor_kind_derivation(
    actor: RequestActor | None, expected_kind: str, expected_id: str | None
) -> None:
    """Each credential shape maps to its persisted actor kind and identifier."""
    client = _RecordingClient()
    _emit(client, actor)
    assert len(client.calls) == 1
    fn, params = client.calls[0]
    assert fn == "record_audit_event"
    assert params["p_actor_kind"] == expected_kind
    assert params["p_actor_id"] == expected_id
    assert params["p_action"] == "projects.create"
    assert params["p_org_id"] == "org-1"


def test_emit_never_raises_and_logs_the_failure(caplog: pytest.LogCaptureFixture) -> None:
    """A dead audit sink is logged loudly but never fails the mutation."""
    with caplog.at_level("ERROR", logger="explabs.api.audit"):
        _emit(_FailingClient(), RequestActor(user_id="user-1", is_platform_admin=False))
    assert any("Audit event write failed" in record.message for record in caplog.records)


def test_snapshots_are_redacted_before_sending() -> None:
    """Secret-shaped keys never reach the RPC payload, at any depth."""
    client = _RecordingClient()
    _emit(
        client,
        RequestActor(user_id="user-1", is_platform_admin=False),
        before={"api_secret": "s", "name": "old"},
        after={
            "name": "new",
            "auth_token": "t",
            "config": {"password_hash": "p", "region": "us"},
            "entries": [{"credential_last4": "abcd", "kept": True}],
        },
    )
    _fn, params = client.calls[0]
    assert params["p_before"] == {"name": "old"}
    assert params["p_after"] == {
        "name": "new",
        "config": {"region": "us"},
        "entries": [{"kept": True}],
    }


def test_redact_snapshot_passes_none_through() -> None:
    """An absent snapshot stays absent rather than becoming an empty object."""
    assert redact_snapshot(None) is None


def test_registry_values_are_dot_namespaced() -> None:
    """Every registry action is a stable lowercase dotted string."""
    for action in AuditAction:
        namespace, _, verb = action.value.partition(".")
        assert namespace, action
        assert verb, action
        assert action.value == action.value.lower()
