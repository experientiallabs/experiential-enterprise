# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for provider data controls (E5.3, DATA_CONTROLS capability gate)."""

from __future__ import annotations

from typing import cast

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, OUTSIDER_ID, TEST_API_KEY, USER_ID
from explabs.api.routes.data_controls import router as data_controls_router
from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.repositories import JsonObject, JsonPayload


class _NoopQuery:
    """RPC stand-in for the audit writer: succeeds with no rows."""

    def execute(self) -> FakeResult:
        """Return an empty result."""
        return FakeResult([])


class _DataControlsClient(FakeSupabaseClient):
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


def _posture_row(provider: str, *, zdr: bool, no_training: bool) -> JsonObject:
    """One seeded ``provider_data_controls`` row."""
    return {
        "provider": provider,
        "zero_data_retention": zdr,
        "no_training": no_training,
        "source_note": f"Documented default API posture for {provider}.",
        "updated_at": "2026-08-22T00:00:00+00:00",
    }


@pytest.fixture
def data_controls_supabase(
    supabase: FakeSupabaseClient, monkeypatch: pytest.MonkeyPatch
) -> _DataControlsClient:
    """The conftest seed on the audit-aware fake, with DATA_CONTROLS licensed."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "data_controls")
    client = _DataControlsClient()
    client.tables = supabase.tables
    client.tables["provider_data_controls"] = [
        _posture_row("bedrock", zdr=True, no_training=True),
        _posture_row("openai", zdr=False, no_training=True),
        _posture_row("openrouter", zdr=False, no_training=False),
    ]
    client.tables.setdefault("org_provider_policies", [])
    return client


def _client(supabase: _DataControlsClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one end user.

    Includes the data-controls router when the app factory has not registered
    it yet (registration lives in app.py, which lands separately), and stays
    idempotent once it has.
    """
    app = create_app(client=supabase)
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/orgs/{org_id}/provider-policy" not in paths:
        app.include_router(data_controls_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def _put_policy(
    client: TestClient,
    *,
    allowed: list[str] | None,
    zdr: bool = False,
    no_training: bool = False,
) -> JsonObject:
    """PUT one policy document as the acting user and return the stored policy."""
    response = client.put(
        f"/api/orgs/{ORG_ID}/provider-policy",
        json={
            "allowed_providers": allowed,
            "require_zdr": zdr,
            "require_no_training": no_training,
        },
    )
    assert response.status_code == 200, response.text
    policy = response.json()["policy"]
    assert isinstance(policy, dict)
    return {str(key): value for key, value in policy.items()}


def test_unlicensed_org_sees_no_policy_surface(
    data_controls_supabase: _DataControlsClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without DATA_CONTROLS the policy routes 404, even for org admins."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "teams")
    admin = _client(data_controls_supabase, ACTOR_ID)
    assert admin.get(f"/api/orgs/{ORG_ID}/provider-policy").status_code == 404
    body = {"allowed_providers": None, "require_zdr": True, "require_no_training": False}
    assert admin.put(f"/api/orgs/{ORG_ID}/provider-policy", json=body).status_code == 404
    assert admin.delete(f"/api/orgs/{ORG_ID}/provider-policy").status_code == 404


def test_posture_matrix_is_not_capability_gated(
    data_controls_supabase: _DataControlsClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The curated matrix stays readable unlicensed: metadata, not /ee surface."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES", raising=False)
    member = _client(data_controls_supabase, USER_ID)
    response = member.get(f"/api/orgs/{ORG_ID}/provider-data-controls")
    assert response.status_code == 200, response.text
    providers = response.json()["providers"]
    assert [row["provider"] for row in providers] == ["bedrock", "openai", "openrouter"]
    assert providers[0]["zero_data_retention"] is True
    assert providers[2]["no_training"] is False
    assert all(row["source_note"] for row in providers)


def test_outsider_sees_nothing(data_controls_supabase: _DataControlsClient) -> None:
    """Non-members get the org 404 on both surfaces."""
    outsider = _client(data_controls_supabase, OUTSIDER_ID)
    assert outsider.get(f"/api/orgs/{ORG_ID}/provider-data-controls").status_code == 404
    assert outsider.get(f"/api/orgs/{ORG_ID}/provider-policy").status_code == 404


def test_member_reads_but_cannot_mutate(data_controls_supabase: _DataControlsClient) -> None:
    """USER-strength callers read the policy; mutations are admin-gated."""
    member = _client(data_controls_supabase, USER_ID)
    read = member.get(f"/api/orgs/{ORG_ID}/provider-policy")
    assert read.status_code == 200, read.text
    assert read.json() == {"org_id": ORG_ID, "policy": None}
    body = {"allowed_providers": None, "require_zdr": True, "require_no_training": False}
    assert member.put(f"/api/orgs/{ORG_ID}/provider-policy", json=body).status_code == 403
    assert member.delete(f"/api/orgs/{ORG_ID}/provider-policy").status_code == 403


def test_admin_creates_policy_with_audit(data_controls_supabase: _DataControlsClient) -> None:
    """A first PUT inserts the row, stamps the actor, and audits before=null."""
    admin = _client(data_controls_supabase, ACTOR_ID)
    policy = _put_policy(admin, allowed=["openai", "bedrock"], zdr=True)
    # Canonicalized: deduplicated and sorted for stable storage and diffs.
    assert policy["allowed_providers"] == ["bedrock", "openai"]
    assert policy["require_zdr"] is True
    assert policy["require_no_training"] is False
    assert policy["created_by"] == ACTOR_ID
    assert policy["updated_by"] == ACTOR_ID
    assert data_controls_supabase.audit_actions() == ["provider_policy.set"]
    event = data_controls_supabase.audit_events[0]
    assert event["p_object_type"] == "provider_policy"
    assert event["p_object_id"] == ORG_ID
    assert event["p_before"] is None
    assert event["p_after"] == {
        "allowed_providers": ["bedrock", "openai"],
        "require_zdr": True,
        "require_no_training": False,
    }


def test_put_replaces_and_audits_before_after(
    data_controls_supabase: _DataControlsClient,
) -> None:
    """A second PUT is full-document replace with before/after in the audit."""
    admin = _client(data_controls_supabase, ACTOR_ID)
    _put_policy(admin, allowed=["bedrock"], zdr=True)
    policy = _put_policy(admin, allowed=None, no_training=True)
    assert policy["allowed_providers"] is None
    assert policy["require_zdr"] is False
    assert policy["require_no_training"] is True
    assert len(data_controls_supabase.tables["org_provider_policies"]) == 1
    replace_event = data_controls_supabase.audit_events[-1]
    assert replace_event["p_action"] == "provider_policy.set"
    assert replace_event["p_before"] == {
        "allowed_providers": ["bedrock"],
        "require_zdr": True,
        "require_no_training": False,
    }
    assert replace_event["p_after"] == {
        "allowed_providers": None,
        "require_zdr": False,
        "require_no_training": True,
    }


def test_unknown_provider_is_a_400_naming_it(
    data_controls_supabase: _DataControlsClient,
) -> None:
    """An allowlist entry outside the posture matrix fails typed, by name."""
    admin = _client(data_controls_supabase, ACTOR_ID)
    response = admin.put(
        f"/api/orgs/{ORG_ID}/provider-policy",
        json={
            "allowed_providers": ["bedrock", "nonsense", "also-fake"],
            "require_zdr": False,
            "require_no_training": False,
        },
    )
    assert response.status_code == 400, response.text
    assert "also-fake, nonsense" in response.json()["error"]
    assert data_controls_supabase.audit_events == []


def test_empty_allowlist_is_refused(data_controls_supabase: _DataControlsClient) -> None:
    """An empty allowlist would refuse all traffic; the boundary rejects it."""
    admin = _client(data_controls_supabase, ACTOR_ID)
    response = admin.put(
        f"/api/orgs/{ORG_ID}/provider-policy",
        json={"allowed_providers": [], "require_zdr": False, "require_no_training": False},
    )
    assert response.status_code == 422, response.text


def test_delete_policy_with_audit(data_controls_supabase: _DataControlsClient) -> None:
    """DELETE removes the row, audits the prior state, and 404s when absent."""
    admin = _client(data_controls_supabase, ACTOR_ID)
    _put_policy(admin, allowed=["bedrock"], zdr=True)
    deleted = admin.delete(f"/api/orgs/{ORG_ID}/provider-policy")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"deleted": True}
    read = admin.get(f"/api/orgs/{ORG_ID}/provider-policy")
    assert read.json() == {"org_id": ORG_ID, "policy": None}
    assert admin.delete(f"/api/orgs/{ORG_ID}/provider-policy").status_code == 404
    assert data_controls_supabase.audit_actions() == [
        "provider_policy.set",
        "provider_policy.delete",
    ]
    assert data_controls_supabase.audit_events[-1]["p_before"] == {
        "allowed_providers": ["bedrock"],
        "require_zdr": True,
        "require_no_training": False,
    }
