# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tool-account routes: YC gating, manual declare, fetch, and disconnect."""

from __future__ import annotations

from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _make_yc_org(supabase: FakeSupabaseClient) -> None:
    """Apply the `yc` org label so the fixture org reads as a YC company."""
    supabase.tables["org_labels"] = [
        {
            "id": "yc-label-1",
            "org_id": ORG_ID,
            "key": "yc",
            "created_by": "user-org-admin",
            "created_at": "2026-08-01T00:00:00Z",
        }
    ]


def test_non_yc_org_sees_only_e2b(api: TestClient) -> None:
    """A non-YC org's tool-account list is E2B alone; the YC vendors are hidden."""
    response = api.get(f"/api/orgs/{ORG_ID}/tool-accounts")
    assert response.status_code == 200
    vendors = [account["vendor"] for account in response.json()]
    assert vendors == ["e2b"]


def test_yc_org_sees_all_tool_vendors(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A YC org sees E2B plus the gated Greptile/Cursor/Devin cards."""
    _make_yc_org(supabase)
    response = api.get(f"/api/orgs/{ORG_ID}/tool-accounts")
    assert response.status_code == 200
    vendors = {account["vendor"] for account in response.json()}
    assert vendors == {"e2b", "greptile", "cursor", "devin"}
    gated = {a["vendor"]: a["yc_gated"] for a in response.json()}
    assert gated["e2b"] is False
    assert gated["greptile"] is True


def test_declare_balance_for_a_tool_account(api: TestClient) -> None:
    """Manual declare sets the tracked balance and the self_reported source."""
    response = api.put(f"/api/orgs/{ORG_ID}/tool-accounts/e2b", json={"declared_balance_usd": 42.5})
    assert response.status_code == 200
    body = response.json()
    assert body["vendor"] == "e2b"
    assert body["declared_balance_usd"] == 42.5
    assert body["balance_source"] == "self_reported"
    assert body["connected"] is True


def test_yc_gated_vendor_is_not_found_for_a_non_yc_org(api: TestClient) -> None:
    """A non-YC org cannot declare or reach a YC-gated vendor (resource 404)."""
    response = api.put(
        f"/api/orgs/{ORG_ID}/tool-accounts/greptile", json={"declared_balance_usd": 10}
    )
    assert response.status_code == 404


def test_yc_gated_vendor_declare_ok_for_a_yc_org(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A YC org can declare a balance for a gated vendor."""
    _make_yc_org(supabase)
    response = api.put(
        f"/api/orgs/{ORG_ID}/tool-accounts/greptile", json={"declared_balance_usd": 10}
    )
    assert response.status_code == 200
    assert response.json()["declared_balance_usd"] == 10.0


def test_unknown_vendor_is_rejected(api: TestClient) -> None:
    """A vendor outside the enum is a typed 400, not a silent create."""
    response = api.put(f"/api/orgs/{ORG_ID}/tool-accounts/notavendor", json={})
    assert response.status_code == 400


def test_fetch_balance_for_e2b_is_pending(api: TestClient) -> None:
    """E2B has no billing API, so the fetch is the stubbed computer-use pending."""
    response = api.post(f"/api/orgs/{ORG_ID}/tool-accounts/e2b/fetch-balance")
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "pending"
    assert body["strategy"] == "computer_use"
    assert body["refreshed"] is False
    assert body["balance_usd"] is None


def test_negative_declared_balance_is_rejected(api: TestClient) -> None:
    """A negative balance is refused before any write."""
    response = api.put(f"/api/orgs/{ORG_ID}/tool-accounts/e2b", json={"declared_balance_usd": -1})
    assert response.status_code == 400


def test_delete_disconnects_a_tool_account(api: TestClient) -> None:
    """Declaring then deleting removes the row."""
    api.put(f"/api/orgs/{ORG_ID}/tool-accounts/e2b", json={"declared_balance_usd": 5})
    response = api.request("DELETE", f"/api/orgs/{ORG_ID}/tool-accounts/e2b")
    assert response.status_code == 200
    assert response.json()["deleted"] is True
