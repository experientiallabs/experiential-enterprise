# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the org-admin audit-log viewer and CSV export."""

from __future__ import annotations

from typing import cast

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, OUTSIDER_ID, TEST_API_KEY, USER_ID
from explabs.api.routes.audit_log import router as audit_log_router
from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload


class _StaticQuery:
    """RPC stand-in returning a fixed row page."""

    def __init__(self, rows: list[JsonObject]) -> None:
        self._rows = rows

    def execute(self) -> FakeResult:
        """Return the prepared rows."""
        return FakeResult([dict(row) for row in self._rows])


class _AuditReadClient(FakeSupabaseClient):
    """Fake client that models the ``audit_log_read`` RPC over a seeded table."""

    def __init__(self) -> None:
        super().__init__()
        self.audit_read_params: list[JsonObject] = []

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Serve audit reads from the seeded table; defer everything else."""
        if fn != "audit_log_read":
            return super().rpc(fn, params)
        self.executed_rpcs.append(fn)
        arguments = dict(params or {})
        self.audit_read_params.append(arguments)
        rows = [
            row
            for row in self.tables.setdefault("audit_log", [])
            if row.get("org_id") == arguments.get("in_org_id")
            and (arguments.get("in_action") is None or row.get("action") == arguments["in_action"])
            and (
                arguments.get("in_object_type") is None
                or row.get("object_type") == arguments["in_object_type"]
            )
            and (
                arguments.get("in_actor_id") is None
                or row.get("actor_id") == arguments["in_actor_id"]
            )
            and (
                arguments.get("in_before") is None
                or str(row.get("created_at", "")) < str(arguments["in_before"])
            )
        ]
        rows.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        raw_limit = arguments.get("in_limit")
        limit = min(max(raw_limit if isinstance(raw_limit, int) else 50, 1), 200)
        # The stand-in satisfies the only member the route touches (execute).
        return cast("FakeQuery", _StaticQuery(rows[:limit]))


def _event_row(
    *,
    event_id: str,
    action: str = "aliases.repoint",
    object_type: str = "alias",
    actor_id: str | None = ACTOR_ID,
    created_at: str,
    org_id: str = ORG_ID,
) -> JsonObject:
    """Seed one audit_log row in the persisted column shape."""
    return {
        "event_id": event_id,
        "org_id": org_id,
        "actor_kind": "user",
        "actor_id": actor_id,
        "action": action,
        "object_type": object_type,
        "object_id": "object-1",
        "before": None,
        "after": {"name": "coding"},
        "context": {},
        "created_at": created_at,
    }


@pytest.fixture(autouse=True)
def _licensed_audit_log(monkeypatch: pytest.MonkeyPatch) -> None:
    """License the audit_log capability: the surface is /ee, off by default."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "audit_log")


@pytest.fixture
def audit_supabase(supabase: FakeSupabaseClient) -> _AuditReadClient:
    """The conftest seed data transplanted onto the audit-aware fake."""
    client = _AuditReadClient()
    client.tables = supabase.tables
    client.tables["audit_log"] = [
        _event_row(event_id="evt-1", created_at="2026-08-20T00:00:00+00:00"),
        _event_row(
            event_id="evt-2",
            action="budgets.set",
            object_type="budget",
            created_at="2026-08-21T00:00:00+00:00",
        ),
        _event_row(
            event_id="evt-other-org",
            org_id="org-2",
            created_at="2026-08-21T01:00:00+00:00",
        ),
    ]
    return client


def _client(supabase: _AuditReadClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one end user.

    Includes the audit-log router when the app factory has not registered it
    yet (registration lives in app.py, which lands separately), and stays
    idempotent once it has.
    """
    app = create_app(client=supabase)
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/orgs/{org_id}/audit-log" not in paths:
        app.include_router(audit_log_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def test_admin_reads_events_newest_first(audit_supabase: _AuditReadClient) -> None:
    """An org admin reads only their org's events, newest first."""
    response = _client(audit_supabase, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/audit-log")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["org_id"] == ORG_ID
    assert [event["event_id"] for event in body["events"]] == ["evt-2", "evt-1"]
    assert body["events"][0]["after"] == {"name": "coding"}
    assert body["events"][0]["actor_kind"] == "user"


def test_member_is_forbidden_and_outsider_sees_nothing(
    audit_supabase: _AuditReadClient,
) -> None:
    """Members below admin get 403; non-members get the resource 404."""
    member = _client(audit_supabase, USER_ID).get(f"/api/orgs/{ORG_ID}/audit-log")
    assert member.status_code == 403
    outsider = _client(audit_supabase, OUTSIDER_ID).get(f"/api/orgs/{ORG_ID}/audit-log")
    assert outsider.status_code == 404


def test_unlicensed_org_gets_404_even_as_admin(
    audit_supabase: _AuditReadClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the audit_log capability the route is absent — 404, not 403.

    An unlicensed install must not confirm the surface exists, so even the
    org admin who would otherwise read it sees the resource 404, and the RPC
    is never reached.
    """
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES")
    response = _client(audit_supabase, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/audit-log")
    assert response.status_code == 404
    assert audit_supabase.audit_read_params == []


def test_filters_pass_through_to_the_rpc(audit_supabase: _AuditReadClient) -> None:
    """Every query filter maps onto its audit_log_read parameter; limit clamps."""
    response = _client(audit_supabase, ACTOR_ID).get(
        f"/api/orgs/{ORG_ID}/audit-log",
        params={
            "action": "budgets.set",
            "object_type": "budget",
            "actor_id": ACTOR_ID,
            "before": "2026-08-22T00:00:00+00:00",
            "limit": 500,
        },
    )
    assert response.status_code == 200
    assert [event["event_id"] for event in response.json()["events"]] == ["evt-2"]
    assert audit_supabase.audit_read_params == [
        {
            "in_org_id": ORG_ID,
            "in_action": "budgets.set",
            "in_object_type": "budget",
            "in_actor_id": ACTOR_ID,
            "in_before": "2026-08-22T00:00:00+00:00",
            "in_limit": 200,
        }
    ]


def test_malformed_before_is_400(audit_supabase: _AuditReadClient) -> None:
    """A bad timestamp fails at the boundary, not as a Postgres 500."""
    response = _client(audit_supabase, ACTOR_ID).get(
        f"/api/orgs/{ORG_ID}/audit-log", params={"before": "yesterday-ish"}
    )
    assert response.status_code == 400


def test_csv_export_streams_an_attachment(audit_supabase: _AuditReadClient) -> None:
    """format=csv returns a text/csv attachment with a header row per column."""
    response = _client(audit_supabase, ACTOR_ID).get(
        f"/api/orgs/{ORG_ID}/audit-log", params={"format": "csv"}
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == (
        f'attachment; filename="audit-log-{ORG_ID}.csv"'
    )
    lines = response.text.strip().splitlines()
    assert lines[0] == (
        "event_id,created_at,actor_kind,actor_id,action,object_type,object_id,before,after,context"
    )
    assert len(lines) == 3
    assert lines[1].startswith("evt-2,")
    # jsonb snapshots export as compact JSON cells (quoted by the CSV writer).
    assert '"{""name"":""coding""}"' in lines[1]
