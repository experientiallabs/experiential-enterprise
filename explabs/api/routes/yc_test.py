# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the YC launch grant routes (self-serve + admin) and budget block.

"YC company" is the ``yc`` org label; the launch credit is a ``yc_launch``
grant carrying its own expiry. Both entry points apply the label + grant through
``apply_yc_launch_grant``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID, ORG_KEY_ID, OTHER_ORG_ID, TEST_API_KEY, USER_ID
from explabs.api.services import billing_notifications
from explabs.db.fake_supabase_test import FakeSupabaseClient

YC_GRANT = 526.0


def _signup_promo_row(org_id: str) -> dict[str, object]:
    """The welcome-grant ledger row the signup trigger writes."""
    return {
        "id": f"promo-{org_id}",
        "org_id": org_id,
        "entry_type": "grant",
        "amount_usd": 20.0,
        "reason": "Welcome credit",
        "source": "signup_promo",
        "source_ref": None,
        "created_by": None,
        "created_at": "2026-08-01T00:00:00+00:00",
    }


def _org_labels(supabase: FakeSupabaseClient, org_id: str) -> list[str]:
    return [
        str(row["key"]) for row in supabase.tables.get("org_labels", []) if row["org_id"] == org_id
    ]


def test_yc_claim_applies_label_and_grant_folding_the_promo(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """Self-serve: the `yc` label + $526 grant land, the $20 promo folded in."""
    supabase.tables["credit_ledger"] = [_signup_promo_row(ORG_ID)]
    response = api.post(
        f"/api/orgs/{ORG_ID}/yc-claim",
        headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["granted_usd"] == YC_GRANT
    # 20 (start) + 526 (grant) - 20 (reversal): total launch credit $526.
    assert body["balance_usd"] == YC_GRANT
    assert isinstance(body["expires_at"], str)
    assert _org_labels(supabase, ORG_ID) == ["yc"]
    sources = [row["source"] for row in supabase.tables["credit_ledger"]]
    assert sources == ["signup_promo", "yc_launch", "yc_launch"]


def test_yc_claim_is_idempotent(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A second claim returns the current state, never a second grant or 409."""
    first = api.post(f"/api/orgs/{ORG_ID}/yc-claim")
    assert first.status_code == 200
    ledger_after_first = len(supabase.tables.get("credit_ledger", []))

    again = api.post(
        f"/api/orgs/{ORG_ID}/yc-claim",
        headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
    )
    assert again.status_code == 200
    assert again.json()["granted_usd"] == YC_GRANT
    assert len(supabase.tables.get("credit_ledger", [])) == ledger_after_first
    assert _org_labels(supabase, ORG_ID) == ["yc"]


def test_yc_claim_foreign_org_is_404(api: TestClient) -> None:
    """A non-member cannot claim into someone else's org."""
    response = api.post(f"/api/orgs/{OTHER_ORG_ID}/yc-claim")
    assert response.status_code == 404


def test_yc_claim_via_org_api_key_applies_the_grant(
    customer_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The agent lane: the org's xpl_ key applies the label + grant."""
    key_row = next(row for row in supabase.tables["api_keys"] if row["id"] == ORG_KEY_ID)
    key_row["created_by"] = USER_ID

    response = customer_api.post(f"/api/orgs/{ORG_ID}/yc-claim")

    assert response.status_code == 200
    assert response.json()["granted_usd"] == YC_GRANT
    assert _org_labels(supabase, ORG_ID) == ["yc"]


def test_yc_claim_via_creatorless_key_still_applies(
    customer_api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """A creatorless key no longer 403s — the grant keys uniqueness on the org."""
    response = customer_api.post(f"/api/orgs/{ORG_ID}/yc-claim")

    assert response.status_code == 200
    assert _org_labels(supabase, ORG_ID) == ["yc"]


def test_yc_claim_pings_slack_on_first_apply(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first apply fires one best-effort webhook POST; a replay does not."""
    monkeypatch.setenv(billing_notifications.SLACK_WEBHOOK_ENV, "https://hooks.example/T/B/x")
    posts: list[tuple[str, dict[str, str]]] = []

    def fake_post(url: str, *, json: dict[str, str], timeout: float) -> object:
        _ = timeout
        posts.append((url, json))

        class _Response:
            status_code = 200

        return _Response()

    monkeypatch.setattr(billing_notifications.httpx, "post", fake_post)

    first = api.post(f"/api/orgs/{ORG_ID}/yc-claim")
    assert first.status_code == 200
    assert len(posts) == 1
    # A replay is idempotent and does NOT ping again.
    api.post(f"/api/orgs/{ORG_ID}/yc-claim")
    assert len(posts) == 1


def test_yc_claim_survives_a_dead_slack_webhook(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Slack being down never fails the customer's claim."""
    monkeypatch.setenv(billing_notifications.SLACK_WEBHOOK_ENV, "https://hooks.example/T/B/x")

    def dead_post(url: str, *, json: dict[str, str], timeout: float) -> object:
        _ = url, json, timeout
        msg = "down"
        raise billing_notifications.httpx.ConnectError(msg)

    monkeypatch.setattr(billing_notifications.httpx, "post", dead_post)

    response = api.post(f"/api/orgs/{ORG_ID}/yc-claim")
    assert response.status_code == 200


class TestAdminYcGrant:
    """POST /api/admin/orgs/{org_id}/yc-grant — operator label + grant w/ expiry."""

    def test_applies_with_explicit_amount_and_expiry(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """An operator marks any org YC and sets the amount + expiry."""
        response = superadmin_api.post(
            f"/api/admin/orgs/{ORG_ID}/yc-grant",
            json={"amount_usd": 1000, "expires_at": "2027-01-01T00:00:00+00:00"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["granted_usd"] == 1000
        assert body["expires_at"] == "2027-01-01T00:00:00+00:00"
        assert body["newly_applied"] is True
        assert _org_labels(supabase, ORG_ID) == ["yc"]

    def test_defaults_amount_and_expiry_when_omitted(self, superadmin_api: TestClient) -> None:
        """Omitting amount/expiry uses the launch defaults ($526, 3 months)."""
        response = superadmin_api.post(f"/api/admin/orgs/{ORG_ID}/yc-grant", json={})
        assert response.status_code == 200
        assert response.json()["granted_usd"] == YC_GRANT

    def test_is_idempotent(self, superadmin_api: TestClient) -> None:
        """Re-running reports newly_applied False, no second grant."""
        superadmin_api.post(f"/api/admin/orgs/{ORG_ID}/yc-grant", json={})
        again = superadmin_api.post(f"/api/admin/orgs/{ORG_ID}/yc-grant", json={})
        assert again.status_code == 200
        assert again.json()["newly_applied"] is False

    def test_requires_platform_admin(self, api: TestClient) -> None:
        """A non-operator cannot reach the admin grant."""
        response = api.post(
            f"/api/admin/orgs/{ORG_ID}/yc-grant",
            headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": USER_ID},
            json={},
        )
        assert response.status_code == 404


def test_budget_carries_the_yc_block_for_an_active_grant(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """The budget poll exposes {claimed_at, expires_at, remaining_estimate_usd}."""
    api.post(f"/api/orgs/{ORG_ID}/yc-claim")

    response = api.get(f"/api/orgs/{ORG_ID}/budget")
    assert response.status_code == 200
    block = response.json()["yc"]
    assert block is not None
    assert isinstance(block["claimed_at"], str)
    assert isinstance(block["expires_at"], str)
    assert block["remaining_estimate_usd"] == YC_GRANT


def test_budget_yc_block_is_null_after_expiry(
    api: TestClient, supabase: FakeSupabaseClient
) -> None:
    """An expired launch grant reads as no YC block."""
    api.post(f"/api/orgs/{ORG_ID}/yc-claim")
    grant = next(
        row
        for row in supabase.tables["credit_ledger"]
        if row.get("source_ref") == f"yc-launch:{ORG_ID}"
    )
    grant["expires_at"] = "2020-01-01T00:00:00+00:00"

    response = api.get(f"/api/orgs/{ORG_ID}/budget")
    assert response.status_code == 200
    assert response.json()["yc"] is None
