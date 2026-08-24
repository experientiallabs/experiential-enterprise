# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for org team management (E4 teams, TEAMS capability gate)."""

from __future__ import annotations

from typing import cast

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, ORG_KEY_ID, OUTSIDER_ID, TEST_API_KEY, USER_ID
from explabs.api.routes.teams import router as teams_router
from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload


class _NoopQuery:
    """RPC stand-in for the audit writer: succeeds with no rows."""

    def execute(self) -> FakeResult:
        """Return an empty result."""
        return FakeResult([])


class _TeamsClient(FakeSupabaseClient):
    """Fake client that records audit emissions instead of failing on them."""

    def __init__(self) -> None:
        super().__init__()
        self.audit_events: list[JsonObject] = []

    def rpc(self, fn: str, params: JsonPayload | None = None) -> FakeQuery:
        """Capture audit writes; defer everything else to the base fake."""
        if fn != "record_audit_event":
            return super().rpc(fn, params)
        self.executed_rpcs.append(fn)
        self.audit_events.append(dict(params or {}))
        # The stand-in satisfies the only member the emitter touches (execute).
        return cast("FakeQuery", _NoopQuery())

    def audit_actions(self) -> list[str]:
        """The emitted audit action values, in order."""
        return [str(event["p_action"]) for event in self.audit_events]


@pytest.fixture
def teams_supabase(supabase: FakeSupabaseClient, monkeypatch: pytest.MonkeyPatch) -> _TeamsClient:
    """The conftest seed data on the audit-aware fake, with TEAMS licensed."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "teams")
    client = _TeamsClient()
    client.tables = supabase.tables
    client.tables.setdefault("organization_teams", [])
    client.tables.setdefault("organization_team_members", [])
    client.tables.setdefault("gateway_identities", [])
    return client


def _client(supabase: _TeamsClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one end user.

    Includes the teams router when the app factory has not registered it yet
    (registration lives in app.py, which lands separately), and stays
    idempotent once it has.
    """
    app = create_app(client=supabase)
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/orgs/{org_id}/teams" not in paths:
        app.include_router(teams_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def _create_team(client: TestClient, name: str = "Platform") -> str:
    """Create one team as the org admin and return its id."""
    response = client.post(f"/api/orgs/{ORG_ID}/teams", json={"name": name})
    assert response.status_code == 200, response.text
    return str(response.json()["team_id"])


def test_unlicensed_org_sees_no_surface(
    teams_supabase: _TeamsClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the TEAMS capability the surface 404s, even for org admins."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "audit_log")
    admin = _client(teams_supabase, ACTOR_ID)
    assert admin.get(f"/api/orgs/{ORG_ID}/teams").status_code == 404
    assert admin.post(f"/api/orgs/{ORG_ID}/teams", json={"name": "Platform"}).status_code == 404


def test_admin_creates_and_lists_teams(teams_supabase: _TeamsClient) -> None:
    """An admin creates a team; the listing carries zeroed counts and audit fires."""
    admin = _client(teams_supabase, ACTOR_ID)
    team_id = _create_team(admin, "Platform")
    listing = admin.get(f"/api/orgs/{ORG_ID}/teams")
    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert body["org_id"] == ORG_ID
    assert [
        (team["team_id"], team["name"], team["member_count"], team["key_count"])
        for team in body["teams"]
    ] == [(team_id, "Platform", 0, 0)]
    assert body["teams"][0]["created_by"] == ACTOR_ID
    assert teams_supabase.audit_actions() == ["teams.create"]
    assert teams_supabase.audit_events[0]["p_object_id"] == team_id


def test_duplicate_and_blank_names_are_refused(teams_supabase: _TeamsClient) -> None:
    """A per-org duplicate name 409s; a whitespace-only name 422s."""
    admin = _client(teams_supabase, ACTOR_ID)
    _create_team(admin, "Platform")
    duplicate = admin.post(f"/api/orgs/{ORG_ID}/teams", json={"name": "Platform"})
    assert duplicate.status_code == 409
    blank = admin.post(f"/api/orgs/{ORG_ID}/teams", json={"name": "   "})
    assert blank.status_code == 422


def test_member_reads_but_cannot_mutate(teams_supabase: _TeamsClient) -> None:
    """USER-strength callers list teams; every mutation is admin-gated."""
    team_id = _create_team(_client(teams_supabase, ACTOR_ID))
    member = _client(teams_supabase, USER_ID)
    assert member.get(f"/api/orgs/{ORG_ID}/teams").status_code == 200
    assert member.post(f"/api/orgs/{ORG_ID}/teams", json={"name": "Rogue"}).status_code == 403
    assert member.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/members/{USER_ID}").status_code == 403
    assert member.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}").status_code == 403


def test_outsider_sees_nothing(teams_supabase: _TeamsClient) -> None:
    """Non-members get the org 404, indistinguishable from an absent org."""
    outsider = _client(teams_supabase, OUTSIDER_ID)
    assert outsider.get(f"/api/orgs/{ORG_ID}/teams").status_code == 404


def test_rename(teams_supabase: _TeamsClient) -> None:
    """Rename lands with audit before/after; collisions and absent teams fail."""
    admin = _client(teams_supabase, ACTOR_ID)
    team_id = _create_team(admin, "Platform")
    _create_team(admin, "Research")
    renamed = admin.patch(f"/api/orgs/{ORG_ID}/teams/{team_id}", json={"name": "Core Platform"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Core Platform"
    collision = admin.patch(f"/api/orgs/{ORG_ID}/teams/{team_id}", json={"name": "Research"})
    assert collision.status_code == 409
    absent = admin.patch(f"/api/orgs/{ORG_ID}/teams/team-absent", json={"name": "X"})
    assert absent.status_code == 404
    rename_event = teams_supabase.audit_events[-1]
    assert rename_event["p_action"] == "teams.rename"
    assert rename_event["p_before"] == {"name": "Platform"}
    assert rename_event["p_after"] == {"name": "Core Platform"}


def test_member_add_and_remove(teams_supabase: _TeamsClient) -> None:
    """Roster mutations require org membership, count in the listing, and audit."""
    admin = _client(teams_supabase, ACTOR_ID)
    team_id = _create_team(admin)
    added = admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/members/{USER_ID}")
    assert added.status_code == 200, added.text
    assert added.json()["user_id"] == USER_ID
    assert added.json()["added_by"] == ACTOR_ID
    # Idempotent re-add: same row back, no second membership, no second audit.
    assert admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/members/{USER_ID}").status_code == 200
    assert len(teams_supabase.tables["organization_team_members"]) == 1
    non_member = admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/members/{OUTSIDER_ID}")
    assert non_member.status_code == 404
    roster = admin.get(f"/api/orgs/{ORG_ID}/teams/{team_id}/members")
    assert roster.status_code == 200
    assert [member["user_id"] for member in roster.json()["members"]] == [USER_ID]
    listing = _client(teams_supabase, ACTOR_ID).get(f"/api/orgs/{ORG_ID}/teams")
    assert listing.json()["teams"][0]["member_count"] == 1
    removed = admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}/members/{USER_ID}")
    assert removed.status_code == 200
    assert removed.json() == {"removed": True}
    assert admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}/members/{USER_ID}").status_code == 404
    assert teams_supabase.audit_actions() == [
        "teams.create",
        "teams.member_add",
        "teams.member_remove",
    ]


def test_key_assign_and_unassign(teams_supabase: _TeamsClient) -> None:
    """Key attribution is org-scoped, shows in key_count, and audits both ways."""
    admin = _client(teams_supabase, ACTOR_ID)
    team_id = _create_team(admin)
    assigned = admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/keys/{ORG_KEY_ID}")
    assert assigned.status_code == 200, assigned.text
    assert assigned.json() == {"api_key_id": ORG_KEY_ID, "team_id": team_id}
    key_row = next(row for row in teams_supabase.tables["api_keys"] if row["id"] == ORG_KEY_ID)
    assert key_row["team_id"] == team_id
    listing = admin.get(f"/api/orgs/{ORG_ID}/teams")
    assert listing.json()["teams"][0]["key_count"] == 1
    assert listing.json()["teams"][0]["assigned_key_ids"] == [ORG_KEY_ID]
    foreign = admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/keys/key-org2")
    assert foreign.status_code == 404
    unassigned = admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}/keys/{ORG_KEY_ID}")
    assert unassigned.status_code == 200
    assert unassigned.json() == {"api_key_id": ORG_KEY_ID, "team_id": None}
    assert key_row["team_id"] is None
    assert admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}/keys/{ORG_KEY_ID}").status_code == 404
    key_events = [
        event for event in teams_supabase.audit_events if event["p_action"] == "teams.key_assign"
    ]
    assert [event["p_after"] for event in key_events] == [
        {"team_id": team_id},
        {"team_id": None},
    ]


def test_delete_refuses_assigned_keys_unless_forced(teams_supabase: _TeamsClient) -> None:
    """Deletion 409s while active keys are assigned; force detaches and says so."""
    admin = _client(teams_supabase, ACTOR_ID)
    team_id = _create_team(admin)
    assert admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/keys/{ORG_KEY_ID}").status_code == 200
    refused = admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}")
    assert refused.status_code == 409
    forced = admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}", params={"force": "true"})
    assert forced.status_code == 200, forced.text
    assert forced.json() == {"team_id": team_id, "deleted": True, "unassigned_key_count": 1}
    key_row = next(row for row in teams_supabase.tables["api_keys"] if row["id"] == ORG_KEY_ID)
    assert key_row["team_id"] is None
    assert admin.get(f"/api/orgs/{ORG_ID}/teams").json()["teams"] == []
    assert teams_supabase.audit_actions()[-1] == "teams.delete"
    assert teams_supabase.audit_events[-1]["p_context"] == {"unassigned_key_count": 1}


def test_revoked_keys_never_block_deletion_or_count(teams_supabase: _TeamsClient) -> None:
    """A revoked key's attribution is history: uncounted, and no delete blocker."""
    admin = _client(teams_supabase, ACTOR_ID)
    team_id = _create_team(admin)
    assert admin.put(f"/api/orgs/{ORG_ID}/teams/{team_id}/keys/key-revoked").status_code == 200
    listing = admin.get(f"/api/orgs/{ORG_ID}/teams")
    assert listing.json()["teams"][0]["key_count"] == 0
    deleted = admin.delete(f"/api/orgs/{ORG_ID}/teams/{team_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["unassigned_key_count"] == 1
