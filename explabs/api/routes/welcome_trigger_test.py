# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the admin welcome-trigger routes (per-org PUT + by-label POST)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID, TEST_API_KEY, USER_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient

YC_GRANT = 526


class TestPutWelcomeTrigger:
    """PUT /api/admin/orgs/{org_id}/welcome-trigger — arm/disarm one org."""

    def test_arms_the_org(self, superadmin_api: TestClient, supabase: FakeSupabaseClient) -> None:
        """Arming writes the row and echoes the announced amount + API-key flag."""
        response = superadmin_api.put(
            f"/api/admin/orgs/{ORG_ID}/welcome-trigger",
            json={"active": True, "display_credit_usd": YC_GRANT, "show_api_key": True},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["active"] is True
        assert body["display_credit_usd"] == YC_GRANT
        assert body["show_api_key"] is True
        row = supabase.tables["org_welcome_trigger"][0]
        assert row["org_id"] == ORG_ID
        assert row["active"] is True

    def test_defaults_show_api_key_true_and_amount_null(self, superadmin_api: TestClient) -> None:
        """Omitting show_api_key/amount defaults to showing the key, null amount."""
        response = superadmin_api.put(
            f"/api/admin/orgs/{ORG_ID}/welcome-trigger", json={"active": True}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["show_api_key"] is True
        assert body["display_credit_usd"] is None

    def test_requires_platform_admin(self, api: TestClient) -> None:
        """A non-operator gets the uniform 404, never the write."""
        response = api.put(
            f"/api/admin/orgs/{ORG_ID}/welcome-trigger",
            headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
            json={"active": True},
        )
        assert response.status_code == 404


class TestGetWelcomeTrigger:
    """GET /api/admin/orgs/{org_id}/welcome-trigger — read persisted state."""

    def test_null_when_never_armed(self, superadmin_api: TestClient) -> None:
        """An org that was never armed reads back {"trigger": null}."""
        response = superadmin_api.get(f"/api/admin/orgs/{ORG_ID}/welcome-trigger")
        assert response.status_code == 200
        assert response.json() == {"trigger": None}

    def test_reflects_persisted_state(self, superadmin_api: TestClient) -> None:
        """After arming, the GET echoes the stored amount and armed state."""
        superadmin_api.put(
            f"/api/admin/orgs/{ORG_ID}/welcome-trigger",
            json={"active": True, "display_credit_usd": YC_GRANT, "show_api_key": False},
        )
        response = superadmin_api.get(f"/api/admin/orgs/{ORG_ID}/welcome-trigger")

        assert response.status_code == 200
        trigger = response.json()["trigger"]
        assert trigger["org_id"] == ORG_ID
        assert trigger["active"] is True
        assert trigger["display_credit_usd"] == YC_GRANT
        assert trigger["show_api_key"] is False

    def test_requires_platform_admin(self, api: TestClient) -> None:
        """A non-operator gets the uniform 404, never the read."""
        response = api.get(
            f"/api/admin/orgs/{ORG_ID}/welcome-trigger",
            headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
        )
        assert response.status_code == 404


class TestWelcomeTriggerByLabel:
    """POST /api/admin/welcome-triggers/by-label — arm a whole cohort."""

    def test_arms_every_labelled_org(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """The cohort lane arms exactly the orgs carrying the label."""
        supabase.tables["org_labels"] = [
            {"org_id": ORG_ID, "key": "yc"},
            {"org_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "key": "yc"},
        ]
        response = superadmin_api.post(
            "/api/admin/welcome-triggers/by-label",
            json={
                "label": "yc",
                "active": True,
                "display_credit_usd": YC_GRANT,
                "show_api_key": True,
            },
        )

        assert response.status_code == 200
        assert response.json()["affected_orgs"] == 2

    def test_requires_platform_admin(self, api: TestClient) -> None:
        """A non-operator gets the uniform 404, never the cohort write."""
        response = api.post(
            "/api/admin/welcome-triggers/by-label",
            headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
            json={"label": "yc", "active": True},
        )
        assert response.status_code == 404
