# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the gateway spend-alert store against the fake Supabase client."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeQuery, FakeResult, FakeSupabaseClient
from explabs.db.stores.gateway_spend_alert_store import (
    DuplicateSpendAlertError,
    GatewaySpendAlertStore,
    SpendAlertRecord,
)

ORG_ID = "org-1"


def _create_org_alert(
    store: GatewaySpendAlertStore, threshold: int = 5_000_000
) -> SpendAlertRecord:
    """Insert one org_monthly_spend rule with a fixed shape."""
    return store.create_alert(
        org_id=ORG_ID,
        kind="org_monthly_spend",
        threshold_micro_usd=threshold,
        budget_id=None,
        threshold_fraction=None,
        notify_email="ops@example.com",
        created_by="user-1",
    )


def _event_row(alert_id: str, *, period: str, fired_at: str) -> dict[str, object]:
    """Seed one gateway_spend_alert_events row with the full column set."""
    return {
        "alert_id": alert_id,
        "period": period,
        "fired_at": fired_at,
        "measured_micro_usd": 6_000_000,
        "threshold_micro_usd": 5_000_000,
        "delivered_at": None,
        "delivery_error": None,
    }


class _InsertRaisingQuery(FakeQuery):
    """A query whose insert raises a PostgREST-shaped SQLSTATE error.

    The dict-argument shape is one of the two postgrest raises for SQLSTATE
    errors (see ``is_unique_violation``); the code comes from the client.
    """

    def execute(self) -> FakeResult:
        """Raise on insert; defer everything else to the real fake."""
        if self.operation == "insert":
            code = getattr(self.client, "error_code", "23505")
            raise RuntimeError({"code": code, "message": "constraint violated"})
        return super().execute()


class _InsertRaisingClient(FakeSupabaseClient):
    """A fake client whose gateway_spend_alerts inserts raise SQLSTATE errors."""

    def __init__(self, *, error_code: str = "23505") -> None:
        """Remember which SQLSTATE the poisoned insert should raise."""
        super().__init__()
        self.error_code = error_code

    def table(self, table_name: str) -> FakeQuery:
        """Swap in the raising query for the alerts table only."""
        query = super().table(table_name)
        if table_name == "gateway_spend_alerts":
            query.__class__ = _InsertRaisingQuery
        return query


def test_create_list_delete_round_trip() -> None:
    """A created rule lists back typed, then deletes exactly once."""
    client = FakeSupabaseClient()
    store = GatewaySpendAlertStore(client)

    created = _create_org_alert(store)
    assert isinstance(created, SpendAlertRecord)
    assert created.alert_id.startswith("alert-")
    assert created.org_id == ORG_ID
    assert created.kind == "org_monthly_spend"
    assert created.threshold_micro_usd == 5_000_000
    assert created.budget_id is None
    assert created.threshold_fraction is None
    assert created.notify_email == "ops@example.com"
    assert created.created_at
    assert created.updated_at == created.created_at

    listed = store.list_alerts(ORG_ID)
    assert listed == (created,)
    # Another org sees nothing.
    assert store.list_alerts("org-2") == ()

    assert store.delete_alert(org_id=ORG_ID, alert_id=created.alert_id) is True
    assert store.list_alerts(ORG_ID) == ()
    assert client.tables["gateway_spend_alerts"] == []


def test_create_maps_budget_fraction_row() -> None:
    """A budget_fraction rule round-trips its budget target and fraction."""
    store = GatewaySpendAlertStore(FakeSupabaseClient())
    created = store.create_alert(
        org_id=ORG_ID,
        kind="budget_fraction",
        threshold_micro_usd=None,
        budget_id="budget-1",
        threshold_fraction=0.8,
        notify_email="fin@example.com",
        created_by=None,
    )
    assert created.kind == "budget_fraction"
    assert created.budget_id == "budget-1"
    assert created.threshold_fraction == 0.8
    assert created.threshold_micro_usd is None


def test_delete_returns_false_when_nothing_matched() -> None:
    """Deleting an absent rule (or the wrong org's rule) reports False."""
    client = FakeSupabaseClient()
    store = GatewaySpendAlertStore(client)
    assert store.delete_alert(org_id=ORG_ID, alert_id="alert-missing") is False

    created = _create_org_alert(store)
    # The org scope fences the delete: another org cannot remove the rule.
    assert store.delete_alert(org_id="org-2", alert_id=created.alert_id) is False
    assert store.list_alerts(ORG_ID) == (created,)


def test_list_events_empty_ids_short_circuits() -> None:
    """An empty id set returns () without touching the table."""
    client = FakeSupabaseClient()
    store = GatewaySpendAlertStore(client)
    assert store.list_events(()) == ()
    assert "gateway_spend_alert_events" not in client.executed_selects


def test_list_events_filters_ids_and_orders_newest_first() -> None:
    """Events come back newest-first and only for the requested rules."""
    client = FakeSupabaseClient()
    store = GatewaySpendAlertStore(client)
    client.tables["gateway_spend_alert_events"] = [
        _event_row("alert-a", period="2026-07", fired_at="2026-07-15T00:00:00Z"),
        _event_row("alert-a", period="2026-08", fired_at="2026-08-15T00:00:00Z"),
        _event_row("alert-b", period="2026-08", fired_at="2026-08-16T00:00:00Z"),
    ]

    events = store.list_events(("alert-a",))
    assert [event.period for event in events] == ["2026-08", "2026-07"]
    assert all(event.alert_id == "alert-a" for event in events)


def test_create_duplicate_raises_typed_error() -> None:
    """A unique-violation-shaped insert error surfaces as the typed duplicate."""
    store = GatewaySpendAlertStore(_InsertRaisingClient())
    with pytest.raises(DuplicateSpendAlertError):
        _create_org_alert(store)


def test_create_reraises_non_unique_errors() -> None:
    """Any other SQLSTATE propagates untouched rather than masquerading as 409."""
    store = GatewaySpendAlertStore(_InsertRaisingClient(error_code="23503"))
    with pytest.raises(RuntimeError):
        _create_org_alert(store)
