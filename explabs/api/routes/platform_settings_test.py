# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the admin credit/spend-unlock settings routes."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from explabs.api.conftest import OPERATOR_ID, TEST_API_KEY
from explabs.db.fake_supabase_test import FakeSupabaseClient

_BASE = "/api/admin/settings"


@pytest.fixture
def seeded(supabase: FakeSupabaseClient) -> FakeSupabaseClient:
    """The api conftest supabase plus the app_settings singleton at its defaults."""
    supabase.tables["app_settings"] = [
        {
            "singleton": True,
            "signups_enabled": True,
            "welcome_grant_micro_usd": 20_000_000,
            "yc_grant_micro_usd": 526_000_000,
            "pre_verify_allowance_micro_usd": 1_000_000,
            "spend_unlock_requirement": "email",
        }
    ]
    return supabase


def _admin(api: TestClient) -> TestClient:
    """A test client acting as the seeded platform admin."""
    return TestClient(
        api.app,
        headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": OPERATOR_ID},
    )


def test_get_returns_the_consolidated_defaults(api: TestClient, seeded: FakeSupabaseClient) -> None:
    """The consolidated read shows every knob at its launch default."""
    _ = seeded
    response = _admin(api).get(f"{_BASE}/credit-gating")

    assert response.status_code == 200
    assert response.json() == {
        "welcome_grant_micro_usd": 20_000_000,
        "yc_grant_micro_usd": 526_000_000,
        "pre_verify_allowance_micro_usd": 1_000_000,
        "pre_verify_enabled": True,
        "spend_unlock_requirement": "email",
    }


def test_pre_verify_toggle_off_then_back_on(api: TestClient, seeded: FakeSupabaseClient) -> None:
    """OFF writes 0 (verify-required), ON writes 1_000_000; both persist."""
    admin = _admin(api)

    off = admin.put(f"{_BASE}/pre-verify-allowance", json={"enabled": False})
    assert off.status_code == 200
    body = off.json()
    assert body["pre_verify_allowance_micro_usd"] == 0
    assert body["pre_verify_enabled"] is False
    assert seeded.tables["app_settings"][0]["pre_verify_allowance_micro_usd"] == 0

    on = admin.put(f"{_BASE}/pre-verify-allowance", json={"enabled": True})
    assert on.json()["pre_verify_enabled"] is True


def test_welcome_and_yc_grant_amounts_are_editable(
    api: TestClient, seeded: FakeSupabaseClient
) -> None:
    """Both grant amounts can be raised and read back."""
    admin = _admin(api)

    welcome = admin.put(f"{_BASE}/welcome-grant", json={"micro_usd": 40_000_000})
    assert welcome.status_code == 200
    assert welcome.json()["welcome_grant_micro_usd"] == 40_000_000

    yc = admin.put(f"{_BASE}/yc-grant", json={"micro_usd": 750_000_000})
    assert yc.status_code == 200
    assert yc.json()["yc_grant_micro_usd"] == 750_000_000
    assert seeded.tables["app_settings"][0]["yc_grant_micro_usd"] == 750_000_000


def test_negative_grant_amount_is_400(api: TestClient, seeded: FakeSupabaseClient) -> None:
    """A negative amount is rejected without a write."""
    _ = seeded
    response = _admin(api).put(f"{_BASE}/welcome-grant", json={"micro_usd": -5})
    assert response.status_code == 400


def test_spend_unlock_requirement_flips_and_validates(
    api: TestClient, seeded: FakeSupabaseClient
) -> None:
    """The mode flips email<->card; an unknown mode is a 400."""
    admin = _admin(api)

    card = admin.put(f"{_BASE}/spend-unlock-requirement", json={"requirement": "card"})
    assert card.status_code == 200
    assert card.json()["spend_unlock_requirement"] == "card"
    assert seeded.tables["app_settings"][0]["spend_unlock_requirement"] == "card"

    bad = admin.put(f"{_BASE}/spend-unlock-requirement", json={"requirement": "sms"})
    assert bad.status_code == 400
    # The bad write left the setting untouched.
    assert seeded.tables["app_settings"][0]["spend_unlock_requirement"] == "card"


def test_all_routes_are_platform_admin_only(api: TestClient, seeded: FakeSupabaseClient) -> None:
    """An org admin (the default api actor) gets not-found on read and every write."""
    assert api.get(f"{_BASE}/credit-gating").status_code == 404
    assert api.put(f"{_BASE}/pre-verify-allowance", json={"enabled": False}).status_code == 404
    assert api.put(f"{_BASE}/welcome-grant", json={"micro_usd": 1}).status_code == 404
    assert api.put(f"{_BASE}/yc-grant", json={"micro_usd": 1}).status_code == 404
    assert (
        api.put(f"{_BASE}/spend-unlock-requirement", json={"requirement": "card"}).status_code
        == 404
    )
    assert seeded.tables["app_settings"][0]["pre_verify_allowance_micro_usd"] == 1_000_000
