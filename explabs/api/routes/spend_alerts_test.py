# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Route tests for the spend-alert management API.

These exercise the HTTP surface against the fake Supabase client: auth gating,
kind/field validation, budget-target checks, and the last-event shaping. The
firing/delivery pipeline (pg_cron -> gateway_spend_alerts_due() -> email) lives
in the database and web tier and is not covered here.

The vanilla fake does not model the ``gateway_spend_alerts_rule_uniq``
expression index, so the duplicate-POST test installs a query wrapper that
enforces it and raises the PostgREST unique-violation shape; the store-level
translation to ``DuplicateSpendAlertError`` is proven in
``explabs/db/stores/gateway_spend_alert_store_test.py``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import ORG_ID, USER_ID
from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.db.repositories import JsonObject

BUDGET_ID = "budget-frac"

ORG_ALERT_BODY: dict[str, object] = {
    "kind": "org_monthly_spend",
    "threshold_micro_usd": 5_000_000,
    "notify_email": "ops@example.com",
}
BUDGET_ALERT_BODY: dict[str, object] = {
    "kind": "budget_fraction",
    "budget_id": BUDGET_ID,
    "threshold_fraction": 0.8,
    "notify_email": "fin@example.com",
}


@pytest.fixture(autouse=True)
def _seed_budget(supabase: FakeSupabaseClient) -> None:
    """Seed one org-owned budget row for budget_fraction alerts to target."""
    supabase.tables["gateway_budgets"] = [
        {
            "budget_id": BUDGET_ID,
            "org_id": ORG_ID,
            "period": "2026-08",
            "scope_kind": "team",
            "api_key_id": None,
            "identity_id": None,
            "alias_id": None,
            "pool_id": None,
            "deployment_id": None,
            "limit_micro_usd": 10_000_000,
            "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z",
        }
    ]


def _alerts_path(org_id: str = ORG_ID) -> str:
    return f"/api/orgs/{org_id}/spend-alerts"


def _event_row(alert_id: str, *, period: str, fired_at: str) -> JsonObject:
    """One full-width gateway_spend_alert_events row."""
    return {
        "alert_id": alert_id,
        "period": period,
        "fired_at": fired_at,
        "measured_micro_usd": 6_000_000,
        "threshold_micro_usd": 5_000_000,
        "delivered_at": None,
        "delivery_error": None,
    }


# -- Unique-index shim for the duplicate test ---------------------------------


def _rule_key(row: JsonObject) -> tuple[object, ...]:
    """The gateway_spend_alerts_rule_uniq expression-index key of one row."""
    return (
        row.get("org_id"),
        row.get("kind"),
        row.get("budget_id") or "",
        row.get("threshold_micro_usd") or -1,
        row.get("threshold_fraction") or -1,
    )


class _UniqueRuleQuery(FakeQuery):
    """A query enforcing the rule uniqueness the vanilla fake skips."""

    def _insert(self) -> list[JsonObject]:
        """Raise the PostgREST 23505 shape when an identical rule exists."""
        existing = {
            _rule_key(row) for row in self.client.tables.setdefault("gateway_spend_alerts", [])
        }
        for payload in self.payloads:
            if _rule_key(payload) in existing:
                raise RuntimeError(
                    {
                        "code": "23505",
                        "message": "duplicate key value violates unique constraint "
                        '"gateway_spend_alerts_rule_uniq"',
                    }
                )
        return super()._insert()


@pytest.fixture
def _enforce_rule_uniqueness(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every fake client's gateway_spend_alerts inserts index-enforcing."""
    original = FakeSupabaseClient.table

    def table(self: FakeSupabaseClient, table_name: str) -> FakeQuery:
        query = original(self, table_name)
        if table_name == "gateway_spend_alerts":
            query.__class__ = _UniqueRuleQuery
        return query

    monkeypatch.setattr(FakeSupabaseClient, "table", table)


# -- Reads --------------------------------------------------------------------


def test_member_lists_empty_alerts(api: TestClient) -> None:
    """A plain member may read; a fresh org has no rules."""
    api.headers["X-Explabs-Actor-Id"] = USER_ID
    response = api.get(_alerts_path())
    assert response.status_code == 200
    assert response.json() == {"alerts": []}


def test_list_includes_newest_event(api: TestClient, supabase: FakeSupabaseClient) -> None:
    """The listing carries each rule's most recent fired event only."""
    created = api.post(_alerts_path(), json=ORG_ALERT_BODY).json()
    supabase.tables["gateway_spend_alert_events"] = [
        _event_row(created["alert_id"], period="2026-07", fired_at="2026-07-15T00:00:00Z"),
        _event_row(created["alert_id"], period="2026-08", fired_at="2026-08-15T00:00:00Z"),
    ]

    alerts = api.get(_alerts_path()).json()["alerts"]
    assert len(alerts) == 1
    last_event = alerts[0]["last_event"]
    assert last_event["period"] == "2026-08"
    assert last_event["fired_at"] == "2026-08-15T00:00:00Z"
    assert last_event["measured_micro_usd"] == 6_000_000
    assert last_event["delivered_at"] is None


# -- Creation -----------------------------------------------------------------


def test_admin_creates_org_monthly_alert(api: TestClient) -> None:
    """An org_monthly_spend rule echoes its shape and then lists back."""
    response = api.post(_alerts_path(), json=ORG_ALERT_BODY)
    assert response.status_code == 201
    body = response.json()
    assert body["alert_id"].startswith("alert-")
    assert body["kind"] == "org_monthly_spend"
    assert body["threshold_micro_usd"] == 5_000_000
    assert body["budget_id"] is None
    assert body["threshold_fraction"] is None
    assert body["notify_email"] == "ops@example.com"
    assert body["created_at"]
    assert body["last_event"] is None

    listed = api.get(_alerts_path()).json()["alerts"]
    assert [alert["alert_id"] for alert in listed] == [body["alert_id"]]


def test_budget_fraction_requires_existing_budget(api: TestClient) -> None:
    """A budget_fraction rule aimed at an unknown budget is a 404."""
    response = api.post(_alerts_path(), json={**BUDGET_ALERT_BODY, "budget_id": "ghost"})
    assert response.status_code == 404


def test_budget_fraction_with_seeded_budget(api: TestClient) -> None:
    """A budget_fraction rule against a real org budget is created."""
    response = api.post(_alerts_path(), json=BUDGET_ALERT_BODY)
    assert response.status_code == 201
    body = response.json()
    assert body["kind"] == "budget_fraction"
    assert body["budget_id"] == BUDGET_ID
    assert body["threshold_fraction"] == 0.8
    assert body["threshold_micro_usd"] is None


@pytest.mark.parametrize(
    "body",
    [
        # org_monthly_spend must not carry budget fields...
        {**ORG_ALERT_BODY, "budget_id": BUDGET_ID},
        {**ORG_ALERT_BODY, "threshold_fraction": 0.5},
        # ...and must carry its threshold.
        {"kind": "org_monthly_spend", "notify_email": "ops@example.com"},
        # budget_fraction must carry both budget fields and no org threshold.
        {"kind": "budget_fraction", "threshold_fraction": 0.8, "notify_email": "a@b.c"},
        {"kind": "budget_fraction", "budget_id": BUDGET_ID, "notify_email": "a@b.c"},
        {**BUDGET_ALERT_BODY, "threshold_micro_usd": 1},
    ],
)
def test_kind_field_mismatch_is_422(api: TestClient, body: dict[str, object]) -> None:
    """Each kind owns a fixed field set; anything else fails validation."""
    assert api.post(_alerts_path(), json=body).status_code == 422


def test_create_forbidden_for_non_admin(api: TestClient) -> None:
    """A plain member may not create rules."""
    api.headers["X-Explabs-Actor-Id"] = USER_ID
    assert api.post(_alerts_path(), json=ORG_ALERT_BODY).status_code == 403


@pytest.mark.usefixtures("_enforce_rule_uniqueness")
def test_duplicate_alert_conflicts(api: TestClient) -> None:
    """An identical rule is refused with 409 via the unique index."""
    assert api.post(_alerts_path(), json=ORG_ALERT_BODY).status_code == 201
    duplicate = api.post(_alerts_path(), json=ORG_ALERT_BODY)
    assert duplicate.status_code == 409
    # A different threshold is a distinct rule and still lands.
    changed = {**ORG_ALERT_BODY, "threshold_micro_usd": 9_000_000}
    assert api.post(_alerts_path(), json=changed).status_code == 201


# -- Deletion -----------------------------------------------------------------


def test_delete_alert_then_404(api: TestClient) -> None:
    """Deleting a rule succeeds once; the second attempt is a 404."""
    created = api.post(_alerts_path(), json=ORG_ALERT_BODY).json()
    path = f"{_alerts_path()}/{created['alert_id']}"
    deleted = api.delete(path)
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert api.delete(path).status_code == 404
    assert api.get(_alerts_path()).json() == {"alerts": []}
