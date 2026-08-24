# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the org capability listing."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import ACTOR_ID, ORG_ID, OUTSIDER_ID, USER_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _as_actor(api: TestClient, actor_id: str) -> TestClient:
    """Re-scope the conftest client to another seeded actor."""
    api.headers["X-Explabs-Actor-Id"] = actor_id
    return api


def test_defaults_to_everything_unlicensed(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the env seam every capability reads unlicensed (off by default)."""
    monkeypatch.delenv("EXPLABS_EE_CAPABILITIES", raising=False)
    response = api.get(f"/api/orgs/{ORG_ID}/capabilities")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "capabilities": {
            "audit_log": "unlicensed",
            "sso": "unlicensed",
            "scim": "unlicensed",
            "teams": "unlicensed",
            "data_controls": "unlicensed",
        }
    }


def test_member_strength_reads_licensed_states(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plain member reads the listing; licensed keys report available."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "audit_log,teams")
    response = _as_actor(api, USER_ID).get(f"/api/orgs/{ORG_ID}/capabilities")
    assert response.status_code == 200, response.text
    assert response.json()["capabilities"] == {
        "audit_log": "available",
        "sso": "unlicensed",
        "scim": "unlicensed",
        "teams": "available",
        "data_controls": "unlicensed",
    }


def test_outsider_gets_the_org_404(api: TestClient) -> None:
    """A non-member cannot tell the org's capability listing from an absent org."""
    response = _as_actor(api, OUTSIDER_ID).get(f"/api/orgs/{ORG_ID}/capabilities")
    assert response.status_code == 404


def test_unknown_org_is_404(api: TestClient) -> None:
    """An absent org 404s before any role or capability resolution."""
    response = _as_actor(api, ACTOR_ID).get("/api/orgs/no-such-org/capabilities")
    assert response.status_code == 404


def test_route_is_registered_by_the_app_factory(supabase: FakeSupabaseClient) -> None:
    """app.py registers the route; the fixtures must not paper over a miss."""
    from explabs.api.app import create_app

    app = create_app(client=supabase)
    paths = {getattr(route, "path", None) for route in app.routes}
    assert "/api/orgs/{org_id}/capabilities" in paths


def test_customer_api_key_is_rejected(customer_api: TestClient) -> None:
    """The listing is dashboard-only: an org ``xpl_`` key is not allowlisted."""
    response = customer_api.get(f"/api/orgs/{ORG_ID}/capabilities")
    assert response.status_code == 401
