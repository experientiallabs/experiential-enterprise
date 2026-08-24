# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the platform-operator entitlement grant/revoke surface."""

from __future__ import annotations

from typing import cast

from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, TEST_API_KEY
from explabs.api.routes.entitlements import router as entitlements_router
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import SupabaseClient

_TENANT_ID = "70000000-0000-4000-8000-000000000002"


def _seeded(*, operator: bool = True) -> FakeSupabaseClient:
    """A fake deployment: one org, optionally an operator actor."""
    supabase = FakeSupabaseClient()
    supabase.tables["organizations"] = [{"id": ORG_ID, "slug": "org", "name": "Org"}]
    supabase.tables["organization_members"] = [
        {"org_id": ORG_ID, "user_id": _TENANT_ID, "role": "admin"}
    ]
    supabase.tables["platform_admins"] = [{"user_id": ACTOR_ID}] if operator else []
    supabase.tables["org_entitlements"] = []
    supabase.tables["audit_log"] = []
    return supabase


def _client(supabase: FakeSupabaseClient, actor_id: str) -> TestClient:
    """Deployment-key client acting as one user; router included if unregistered."""
    app = create_app(client=cast("SupabaseClient", supabase))
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/admin/orgs/{org_id}/entitlements" not in paths:
        app.include_router(entitlements_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": actor_id,
        },
    )


def test_grant_then_list_then_revoke() -> None:
    """The operator lifecycle: grant licenses the org, revoke removes it."""
    supabase = _seeded()
    api = _client(supabase, ACTOR_ID)
    granted = api.put(
        f"/api/admin/orgs/{ORG_ID}/entitlements/teams", json={"note": "pilot for Acme"}
    )
    assert granted.status_code == 200, granted.text
    assert granted.json()["capability"] == "teams"
    listed = api.get(f"/api/admin/orgs/{ORG_ID}/entitlements")
    assert [row["capability"] for row in listed.json()["entitlements"]] == ["teams"]
    revoked = api.delete(f"/api/admin/orgs/{ORG_ID}/entitlements/teams")
    assert revoked.status_code == 200, revoked.text
    assert supabase.tables["org_entitlements"] == []


def test_grant_emits_audit_event() -> None:
    """Selling surfaces are governance surfaces: grants land in the audit log."""
    supabase = _seeded()
    api = _client(supabase, ACTOR_ID)
    response = api.put(f"/api/admin/orgs/{ORG_ID}/entitlements/sso", json={})
    assert response.status_code == 200, response.text
    assert "record_audit_event" in supabase.executed_rpcs, "grant must emit an audit event"


def test_non_operator_gets_absent_not_forbidden() -> None:
    """Tenant admins never learn the surface exists."""
    api = _client(_seeded(operator=False), _TENANT_ID)
    assert api.get(f"/api/admin/orgs/{ORG_ID}/entitlements").status_code == 404
    assert api.put(f"/api/admin/orgs/{ORG_ID}/entitlements/teams", json={}).status_code == 404


def test_unknown_capability_is_absent() -> None:
    """A made-up capability key is a 404, not a validation hint."""
    api = _client(_seeded(), ACTOR_ID)
    assert api.put(f"/api/admin/orgs/{ORG_ID}/entitlements/warp_drive", json={}).status_code == 404


def test_past_expiry_is_refused() -> None:
    """A grant that would be born dead is a caller mistake, said plainly."""
    api = _client(_seeded(), ACTOR_ID)
    response = api.put(
        f"/api/admin/orgs/{ORG_ID}/entitlements/scim",
        json={"expires_at": "2020-01-01T00:00:00+00:00"},
    )
    assert response.status_code == 400, response.text


def test_granted_org_resolves_available_via_registry() -> None:
    """End to end: a grant flips org_capabilities for exactly that org."""
    from explabs.api.capabilities import org_capabilities

    supabase = _seeded()
    api = _client(supabase, ACTOR_ID)
    response = api.put(f"/api/admin/orgs/{ORG_ID}/entitlements/audit_log", json={})
    assert response.status_code == 200, response.text
    client = cast("SupabaseClient", supabase)
    assert org_capabilities(client, ORG_ID)["audit_log"] == "available"
    assert org_capabilities(client, "other-org")["audit_log"] == "unlicensed"
