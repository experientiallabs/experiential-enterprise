# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the org-admin SCIM token management surface."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import ACTOR_ID, ORG_ID, TEST_API_KEY, USER_ID
from explabs.api.routes.scim_admin import router as scim_admin_router
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.api_key_store import hash_api_key


@pytest.fixture(autouse=True)
def _scim_capability(monkeypatch: pytest.MonkeyPatch) -> None:
    """License SCIM for the test deployment (default-off otherwise)."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "scim")


@pytest.fixture
def admin_api(supabase: FakeSupabaseClient) -> TestClient:
    """An org-admin client against an app with the SCIM admin router mounted."""
    supabase.tables.setdefault("org_scim_tokens", [])
    app = create_app(client=supabase)
    # create_app deliberately stays untouched by this change; the integrator
    # registers the router with the one line mirrored here.
    app.include_router(scim_admin_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )


@pytest.fixture
def member_api(supabase: FakeSupabaseClient) -> TestClient:
    """A client acting as the seeded non-admin member over the same fake."""
    app = create_app(client=supabase)
    app.include_router(scim_admin_router)
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": USER_ID,
        },
    )


def _token_rows(supabase: FakeSupabaseClient) -> list[dict[str, object]]:
    """The org_scim_tokens table contents."""
    return supabase.tables["org_scim_tokens"]


def test_unlicensed_surface_is_absent(
    admin_api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without the capability the whole surface 404s (absent, not forbidden)."""
    monkeypatch.setenv("EXPLABS_EE_CAPABILITIES", "")
    assert admin_api.get(f"/api/orgs/{ORG_ID}/scim-token").status_code == 404
    assert admin_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={}).status_code == 404
    assert admin_api.delete(f"/api/orgs/{ORG_ID}/scim-token").status_code == 404


def test_status_before_any_mint(admin_api: TestClient) -> None:
    """A fresh org has no token and says so."""
    response = admin_api.get(f"/api/orgs/{ORG_ID}/scim-token")
    assert response.status_code == 200
    assert response.json() == {
        "exists": False,
        "last4": None,
        "created_at": None,
        "revoked_at": None,
        "key_policy": None,
    }


def test_mint_returns_the_bearer_exactly_once(
    admin_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Mint returns the plaintext once; status shows only the last4 after."""
    response = admin_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={"key_policy": "keep"})
    assert response.status_code == 200
    body = response.json()
    token = body["token"]
    assert token.startswith("xplscim_")
    assert body["last4"] == token[-4:]
    assert body["key_policy"] == "keep"

    rows = _token_rows(supabase)
    assert len(rows) == 1
    assert rows[0]["token_hash"] == hash_api_key(token)
    assert token not in str(rows[0])  # hash-only: the plaintext is never stored

    status = admin_api.get(f"/api/orgs/{ORG_ID}/scim-token").json()
    assert status["exists"] is True
    assert status["last4"] == token[-4:]
    assert status["revoked_at"] is None
    assert "token" not in status
    assert "record_audit_event" in supabase.executed_rpcs


def test_remint_replaces_and_invalidates_the_previous_bearer(
    admin_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Rotation path: minting again leaves exactly one row with the new hash."""
    first = admin_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={}).json()["token"]
    second = admin_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={}).json()["token"]
    assert first != second
    rows = _token_rows(supabase)
    assert len(rows) == 1
    assert rows[0]["token_hash"] == hash_api_key(second)


def test_revoke_stamps_the_row_and_second_revoke_404s(
    admin_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Revocation is visible in status; there is nothing left to revoke twice."""
    admin_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={})
    response = admin_api.delete(f"/api/orgs/{ORG_ID}/scim-token")
    assert response.status_code == 200
    assert response.json()["revoked_at"] is not None
    assert _token_rows(supabase)[0]["revoked_at"] is not None
    assert admin_api.delete(f"/api/orgs/{ORG_ID}/scim-token").status_code == 404


def test_member_strength_cannot_manage_the_token(member_api: TestClient) -> None:
    """Token management is admin-only at the org."""
    assert member_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={}).status_code == 403
    assert member_api.delete(f"/api/orgs/{ORG_ID}/scim-token").status_code == 403


def test_default_key_policy_is_revoke(admin_api: TestClient) -> None:
    """The safe offboarding default applies when the body does not choose."""
    body = admin_api.post(f"/api/orgs/{ORG_ID}/scim-token", json={}).json()
    assert body["key_policy"] == "revoke"
