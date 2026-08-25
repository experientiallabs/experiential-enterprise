# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for POST /api/admin/orgs/resolve-emails (email -> org resolution)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID, OTHER_ORG_ID, TEST_API_KEY, USER_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _seed_users(supabase: FakeSupabaseClient) -> None:
    """A founder in ORG_ID and an unrelated user in OTHER_ORG_ID."""
    supabase.tables["auth_users"] = [
        {"id": "founder-1", "email": "Founder@Haladir.com"},
        {"id": "founder-2", "email": "other@example.com"},
    ]
    supabase.tables["organization_members"] = [
        {"org_id": ORG_ID, "user_id": "founder-1", "role": "admin"},
        {"org_id": OTHER_ORG_ID, "user_id": "founder-2", "role": "admin"},
    ]


class TestResolveEmails:
    """POST /api/admin/orgs/resolve-emails."""

    def test_resolves_email_to_its_org(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """A known email resolves to its org with slug/name/role; match is case-insensitive."""
        _seed_users(supabase)
        response = superadmin_api.post(
            "/api/admin/orgs/resolve-emails", json={"emails": ["founder@haladir.com"]}
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert len(results) == 1
        assert results[0]["email"] == "founder@haladir.com"
        orgs = results[0]["orgs"]
        assert len(orgs) == 1
        assert orgs[0]["org_id"] == ORG_ID
        assert orgs[0]["role"] == "admin"

    def test_unknown_email_returns_empty_orgs(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """An email with no account still gets an entry, with no orgs."""
        _seed_users(supabase)
        response = superadmin_api.post(
            "/api/admin/orgs/resolve-emails", json={"emails": ["nobody@nowhere.com"]}
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert results == [{"email": "nobody@nowhere.com", "orgs": []}]

    def test_preserves_one_entry_per_requested_email(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """The response mirrors the requested list, in order, one entry each."""
        _seed_users(supabase)
        response = superadmin_api.post(
            "/api/admin/orgs/resolve-emails",
            json={"emails": ["founder@haladir.com", "nobody@nowhere.com"]},
        )
        assert [r["email"] for r in response.json()["results"]] == [
            "founder@haladir.com",
            "nobody@nowhere.com",
        ]

    def test_trims_whitespace_around_pasted_emails(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """A pasted email with surrounding whitespace still resolves (and echoes trimmed)."""
        _seed_users(supabase)
        response = superadmin_api.post(
            "/api/admin/orgs/resolve-emails", json={"emails": ["  founder@haladir.com  "]}
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert results[0]["email"] == "founder@haladir.com"
        assert len(results[0]["orgs"]) == 1

    def test_rejects_blank_and_oversized_batches(self, superadmin_api: TestClient) -> None:
        """A blank-only list and a batch over the cap are 422 validation errors."""
        blank = superadmin_api.post("/api/admin/orgs/resolve-emails", json={"emails": ["   "]})
        assert blank.status_code == 422
        oversized = superadmin_api.post(
            "/api/admin/orgs/resolve-emails",
            json={"emails": [f"x{i}@example.com" for i in range(501)]},
        )
        assert oversized.status_code == 422

    def test_requires_platform_admin(self, api: TestClient) -> None:
        """A non-operator gets the uniform 404, never the resolution."""
        response = api.post(
            "/api/admin/orgs/resolve-emails",
            headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
            json={"emails": ["founder@haladir.com"]},
        )
        assert response.status_code == 404


class TestRenameOrg:
    """PUT /api/admin/orgs/{org_id}/rename."""

    def test_renames_name_and_slug(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """Rename writes the new display name and slug onto the org row."""
        response = superadmin_api.put(
            f"/api/admin/orgs/{ORG_ID}/rename", json={"name": "Haladir", "slug": "haladir"}
        )
        assert response.status_code == 200
        assert response.json()["name"] == "Haladir"
        org = next(row for row in supabase.tables["organizations"] if row["id"] == ORG_ID)
        assert org["name"] == "Haladir"
        assert org["slug"] == "haladir"

    def test_name_only_leaves_slug(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """Omitting slug renames the display name and leaves the slug intact."""
        before = next(row for row in supabase.tables["organizations"] if row["id"] == ORG_ID)[
            "slug"
        ]
        response = superadmin_api.put(f"/api/admin/orgs/{ORG_ID}/rename", json={"name": "Haladir"})
        assert response.status_code == 200
        org = next(row for row in supabase.tables["organizations"] if row["id"] == ORG_ID)
        assert org["name"] == "Haladir"
        assert org["slug"] == before

    def test_blank_name_rejected(self, superadmin_api: TestClient) -> None:
        """A blank name is a 422 validation error, not a silent rename."""
        response = superadmin_api.put(f"/api/admin/orgs/{ORG_ID}/rename", json={"name": "   "})
        assert response.status_code == 422

    def test_requires_platform_admin(self, api: TestClient) -> None:
        """A non-operator gets the uniform 404, never the rename."""
        response = api.put(
            f"/api/admin/orgs/{ORG_ID}/rename",
            headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
            json={"name": "Haladir"},
        )
        assert response.status_code == 404
