# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for org credit enforcement across retained spend routes."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from explabs.api.conftest import (
    ACTOR_ID,
    OPERATOR_ID,
    ORG_ID,
    OTHER_ORG_SESSION_ID,
    OUTSIDER_ID,
    TEST_API_KEY,
)
from explabs.db.fake_supabase_test import FakeSupabaseClient


def _set_org_credit(supabase: FakeSupabaseClient, granted: float) -> None:
    """Set org-1's granted-credit counter directly on the fake row."""
    for org in supabase.tables["organizations"]:
        if org["id"] == ORG_ID:
            org["credit_granted_usd"] = granted
            return
    raise AssertionError(f"org {ORG_ID} not seeded")


def _seed_spend(supabase: FakeSupabaseClient, cost_usd: float) -> None:
    """Move org-1's spend counters, standing in for the database triggers."""
    for org in supabase.tables["organizations"]:
        if org["id"] == ORG_ID:
            for column in ("spend_usd", "billable_spend_usd"):
                current = org.get(column)
                already = float(current) if isinstance(current, int | float) else 0.0
                org[column] = already + cost_usd


def _client(app: FastAPI) -> TestClient:
    """Authenticated test client acting as the seeded org admin."""
    return TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )


def test_org_usage_endpoint_reports_spend_and_credit(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """The usage view is the credit counters: the same read the 402 gate performs."""
    _set_org_credit(supabase, 20)
    _seed_spend(supabase, 12.5)

    response = api.get(f"/api/orgs/{ORG_ID}/usage")

    assert response.status_code == 200
    assert response.json()["credit"] == {
        "spend_usd": 12.5,
        "billable_spend_usd": 12.5,
        "credit_granted_usd": 20.0,
        "credit_balance_usd": 7.5,
        "yc": None,
    }


def test_platform_org_usage_reports_every_org_in_one_call(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """The bulk view carries per-org spend and credits for the whole platform."""
    _set_org_credit(supabase, 20)
    _seed_spend(supabase, 12.5)
    admin_api = TestClient(
        api.app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": OPERATOR_ID,
        },
    )

    response = admin_api.get("/api/orgs/usage")

    assert response.status_code == 200
    by_org = {row["org_id"]: row for row in response.json()["orgs"]}
    assert by_org[ORG_ID]["spend_usd"] == 12.5
    assert by_org[ORG_ID]["credit_granted_usd"] == 20
    assert by_org[ORG_ID]["credit_balance_usd"] == 7.5
    # The gateway billing-policy signals ride the same bulk read.
    assert by_org[ORG_ID]["free_credit_caps_lifted_at"] is None
    assert by_org[ORG_ID]["gateway_unknown_cost_attempts"] == 0
    # The second seeded org appears too.
    assert "org-2" in by_org


def test_platform_org_usage_hidden_from_non_platform_admins(api: TestClient) -> None:
    """The bulk view is a platform-admin surface; org admins get a 404."""
    response = api.get("/api/orgs/usage")

    assert response.status_code == 404


def test_org_usage_endpoint_hidden_from_non_members(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """Foreign orgs' usage is a 404, indistinguishable from an absent org."""
    outsider_api = TestClient(
        api.app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": OUTSIDER_ID,
        },
    )

    response = outsider_api.get(f"/api/orgs/{ORG_ID}/usage")

    assert response.status_code == 404
    # The other org's seeded session must not leak either.
    assert OTHER_ORG_SESSION_ID not in response.text


def test_credit_ledger_lists_org_history_newest_first(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """Members read their org's grants and adjustments, newest first."""
    supabase.tables["credit_ledger"] = [
        {
            "id": "entry-1",
            "org_id": ORG_ID,
            "entry_type": "grant",
            "amount_usd": 20.0,
            "reason": "Welcome credit",
            "source": "signup_promo",
            "source_ref": None,
            "created_by": None,
            "created_at": "2026-07-01T00:00:00Z",
        },
        {
            "id": "entry-2",
            "org_id": ORG_ID,
            "entry_type": "adjustment",
            "amount_usd": -5.0,
            "reason": "Support correction",
            "source": "admin",
            "source_ref": None,
            "created_by": ACTOR_ID,
            "created_at": "2026-07-02T00:00:00Z",
        },
        {
            "id": "entry-other-org",
            "org_id": "org-other",
            "entry_type": "grant",
            "amount_usd": 50.0,
            "reason": None,
            "source": "admin",
            "source_ref": None,
            "created_by": None,
            "created_at": "2026-07-03T00:00:00Z",
        },
    ]

    response = api.get(f"/api/orgs/{ORG_ID}/credit/ledger")

    assert response.status_code == 200
    entries = response.json()["entries"]
    assert [entry["id"] for entry in entries] == ["entry-2", "entry-1"]
    # Server-side handles stay server-side.
    assert "source_ref" not in entries[0]
    assert "created_by" not in entries[0]


def test_admin_credit_grant_appends_and_returns_the_new_balance(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """A platform admin grant lands in the ledger; negatives become adjustments."""
    supabase.tables["credit_ledger"] = []
    _set_org_credit(supabase, 20)
    admin_api = TestClient(
        api.app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": OPERATOR_ID,
        },
    )

    response = admin_api.post(
        f"/api/admin/orgs/{ORG_ID}/credit-grants",
        json={"amount_usd": 100, "reason": "support bump"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["entry"]["entry_type"] == "grant"
    assert body["entry"]["amount_usd"] == 100
    rows = supabase.tables["credit_ledger"]
    assert len(rows) == 1
    assert rows[0]["source"] == "admin"

    negative = admin_api.post(
        f"/api/admin/orgs/{ORG_ID}/credit-grants",
        json={"amount_usd": -30, "reason": "granted in error"},
    )
    assert negative.status_code == 201
    assert negative.json()["entry"]["entry_type"] == "adjustment"


def test_admin_credit_grant_hidden_from_org_admins(api: TestClient) -> None:
    """Granting credit is a platform-admin surface; org admins get a 404."""
    response = api.post(
        f"/api/admin/orgs/{ORG_ID}/credit-grants",
        json={"amount_usd": 100},
    )

    assert response.status_code == 404


def test_admin_credit_grant_refuses_a_zero_amount(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """A zero grant is noise, refused before it reaches the ledger."""
    admin_api = TestClient(
        api.app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": OPERATOR_ID,
        },
    )

    response = admin_api.post(
        f"/api/admin/orgs/{ORG_ID}/credit-grants",
        json={"amount_usd": 0},
    )

    assert response.status_code == 400


def test_admin_free_credit_caps_lift_and_restore(
    api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """A platform admin lifts the free-credit daily caps and restores them.

    The database predicate (gateway_org_free_credit_funded) reads the
    timestamp this endpoint writes: set means uncapped, null means the launch
    rule (caps until the first paid top-up) applies.
    """
    admin_api = TestClient(
        api.app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": OPERATOR_ID,
        },
    )

    lifted = admin_api.put(
        f"/api/admin/orgs/{ORG_ID}/free-credit-caps",
        json={"lifted": True},
    )

    assert lifted.status_code == 200
    lifted_at = lifted.json()["free_credit_caps_lifted_at"]
    assert isinstance(lifted_at, str)
    assert lifted_at
    org = next(row for row in supabase.tables["organizations"] if row["id"] == ORG_ID)
    assert org["free_credit_caps_lifted_at"] == lifted_at

    restored = admin_api.put(
        f"/api/admin/orgs/{ORG_ID}/free-credit-caps",
        json={"lifted": False},
    )

    assert restored.status_code == 200
    assert restored.json()["free_credit_caps_lifted_at"] is None
    assert org["free_credit_caps_lifted_at"] is None


def test_admin_free_credit_caps_hidden_from_org_admins(api: TestClient) -> None:
    """Lifting caps authorizes real free spend; org admins get a 404."""
    response = api.put(
        f"/api/admin/orgs/{ORG_ID}/free-credit-caps",
        json={"lifted": True},
    )

    assert response.status_code == 404


def test_admin_free_credit_caps_requires_an_existing_org(api: TestClient) -> None:
    """The write refuses unknown organizations instead of upserting state."""
    admin_api = TestClient(
        api.app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": OPERATOR_ID,
        },
    )

    response = admin_api.put(
        "/api/admin/orgs/org-missing/free-credit-caps",
        json={"lifted": True},
    )

    assert response.status_code == 404
