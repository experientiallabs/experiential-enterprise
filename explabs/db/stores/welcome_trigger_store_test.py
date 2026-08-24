# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the welcome-trigger store (per-org + by-label admin writes)."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.welcome_trigger_store import WelcomeTriggerStore

ORG_A = "11111111-1111-1111-1111-111111111111"
ORG_B = "22222222-2222-2222-2222-222222222222"
ADMIN = "99999999-9999-9999-9999-999999999999"
YC_GRANT = 526.0


def test_set_trigger_arms_the_org() -> None:
    """Arming writes the row with the announced amount and API-key flag."""
    store = WelcomeTriggerStore(FakeSupabaseClient())
    trigger = store.set_trigger(
        ORG_A, active=True, display_credit_usd=YC_GRANT, show_api_key=True, updated_by=ADMIN
    )

    assert trigger.org_id == ORG_A
    assert trigger.active is True
    assert trigger.display_credit_usd == YC_GRANT
    assert trigger.show_api_key is True


def test_set_trigger_deactivate_keeps_triggered_at() -> None:
    """Deactivating leaves the last triggered_at (only activation re-arms it)."""
    client = FakeSupabaseClient()
    store = WelcomeTriggerStore(client)
    armed = store.set_trigger(
        ORG_A, active=True, display_credit_usd=YC_GRANT, show_api_key=True, updated_by=ADMIN
    )
    disarmed = store.set_trigger(
        ORG_A, active=False, display_credit_usd=YC_GRANT, show_api_key=True, updated_by=ADMIN
    )

    assert disarmed.active is False
    assert disarmed.triggered_at == armed.triggered_at


def test_display_credit_usd_may_be_none() -> None:
    """A null announced amount falls back to the launch grant at display time."""
    store = WelcomeTriggerStore(FakeSupabaseClient())
    trigger = store.set_trigger(
        ORG_A, active=True, display_credit_usd=None, show_api_key=False, updated_by=None
    )

    assert trigger.display_credit_usd is None
    assert trigger.show_api_key is False


def test_apply_by_label_covers_every_labelled_org() -> None:
    """The cohort lane arms exactly the orgs carrying the label."""
    client = FakeSupabaseClient()
    client.tables["org_labels"] = [
        {"org_id": ORG_A, "key": "yc"},
        {"org_id": ORG_B, "key": "yc"},
        {"org_id": "33333333-3333-3333-3333-333333333333", "key": "partner"},
    ]
    store = WelcomeTriggerStore(client)

    affected = store.apply_by_label(
        "yc", active=True, display_credit_usd=YC_GRANT, show_api_key=True, updated_by=ADMIN
    )

    assert affected == 2
    armed = {row["org_id"] for row in client.tables["org_welcome_trigger"] if row["active"]}
    assert armed == {ORG_A, ORG_B}


def test_apply_by_label_absent_label_is_zero() -> None:
    """A label no org carries arms nothing and reports zero."""
    store = WelcomeTriggerStore(FakeSupabaseClient())
    affected = store.apply_by_label(
        "nope", active=True, display_credit_usd=10.0, show_api_key=True, updated_by=ADMIN
    )
    assert affected == 0


def test_get_trigger_returns_none_when_never_armed() -> None:
    """An org that was never armed reads back as None (the card shows disarmed)."""
    store = WelcomeTriggerStore(FakeSupabaseClient())
    assert store.get_trigger(ORG_A) is None


def test_get_trigger_reads_persisted_state() -> None:
    """get_trigger reflects the org's actual stored amount and armed state."""
    client = FakeSupabaseClient()
    store = WelcomeTriggerStore(client)
    store.set_trigger(
        ORG_A, active=True, display_credit_usd=YC_GRANT, show_api_key=False, updated_by=ADMIN
    )

    trigger = store.get_trigger(ORG_A)

    assert trigger is not None
    assert trigger.org_id == ORG_A
    assert trigger.active is True
    assert trigger.display_credit_usd == YC_GRANT
    assert trigger.show_api_key is False
