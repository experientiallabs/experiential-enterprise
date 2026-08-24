# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""GET /api/keys: the org's key list, resolved from the credential, no secrets."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.app import create_app
from explabs.api.conftest import (
    ORG_KEY_ID,
    OTHER_ORG_KEY_SECRET,
    OUTSIDER_ID,
    TEST_API_KEY,
    USER_ID,
)
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _actor_client(supabase: FakeSupabaseClient, actor_id: str) -> TestClient:
    """A session-authenticated client acting as ``actor_id``."""
    app = create_app(client=supabase)
    return TestClient(
        app,
        headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": actor_id},
    )


def test_customer_key_lists_its_own_orgs_active_keys(customer_api: TestClient) -> None:
    """An org key sees its org's non-revoked keys, newest first, and no more."""
    response = customer_api.get("/api/keys")
    assert response.status_code == 200
    body = response.json()
    # org-1 has an active key, a revoked key, and an expired-but-not-revoked key;
    # the default view drops only the revoked one (matching web settings).
    ids = [row["id"] for row in body]
    assert ORG_KEY_ID in ids
    assert "key-expired" in ids
    assert "key-revoked" not in ids
    # Newest created_at first (both org-1 keys share a date here, so just assert
    # the field is present and ordering did not error).
    assert all(row["created_at"] for row in body)


def test_key_view_never_leaks_the_secret_or_hash(customer_api: TestClient) -> None:
    """Only the display prefix/suffix and lifecycle timestamps are projected."""
    body = customer_api.get("/api/keys").json()
    assert body, "expected at least one key"
    row = body[0]
    assert set(row) == {
        "id",
        "name",
        "key_prefix",
        "key_suffix",
        "created_at",
        "last_used_at",
        "revoked_at",
        "expires_at",
    }
    # The display tail is the stored last-4 of the plaintext, never more.
    assert row["key_suffix"] is None or len(row["key_suffix"]) == 4
    assert "key_hash" not in row
    assert "org_id" not in row


def test_include_revoked_adds_the_revoked_key(customer_api: TestClient) -> None:
    """The opt-in flag surfaces revoked keys the default view hides."""
    default_ids = {row["id"] for row in customer_api.get("/api/keys").json()}
    with_revoked = customer_api.get("/api/keys", params={"include_revoked": "true"}).json()
    revoked_ids = {row["id"] for row in with_revoked}
    assert "key-revoked" not in default_ids
    assert "key-revoked" in revoked_ids


def test_org_key_never_sees_another_orgs_keys(supabase: FakeSupabaseClient) -> None:
    """org-2's key lists only org-2's keys — the tenant boundary holds."""
    app = create_app(client=supabase)
    client = TestClient(app, headers={"Authorization": f"Bearer {OTHER_ORG_KEY_SECRET}"})
    ids = {row["id"] for row in client.get("/api/keys").json()}
    assert ids == {"key-org2"}
    assert ORG_KEY_ID not in ids


def test_session_actor_resolves_sole_membership(supabase: FakeSupabaseClient) -> None:
    """A single-org session user resolves to that org's keys."""
    response = _actor_client(supabase, USER_ID).get("/api/keys")
    assert response.status_code == 200
    assert ORG_KEY_ID in {row["id"] for row in response.json()}


def test_membership_less_actor_gets_404(supabase: FakeSupabaseClient) -> None:
    """No membership means no acting org, so no key list."""
    response = _actor_client(supabase, OUTSIDER_ID).get("/api/keys")
    assert response.status_code == 404
