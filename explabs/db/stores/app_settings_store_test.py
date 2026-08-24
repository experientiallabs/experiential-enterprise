# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the app_settings store (credit/spend-unlock knobs)."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.app_settings_store import (
    PRE_VERIFY_ALLOWANCE_OFF_MICRO_USD,
    PRE_VERIFY_ALLOWANCE_ON_MICRO_USD,
    AppSettingsStore,
)


@pytest.fixture
def supabase() -> FakeSupabaseClient:
    """Fake client seeded with the singleton app_settings row at its defaults."""
    client = FakeSupabaseClient()
    client.tables["app_settings"] = [
        {
            "singleton": True,
            "signups_enabled": True,
            "welcome_grant_micro_usd": 20_000_000,
            "yc_grant_micro_usd": 526_000_000,
            "pre_verify_allowance_micro_usd": PRE_VERIFY_ALLOWANCE_ON_MICRO_USD,
            "spend_unlock_requirement": "email",
        }
    ]
    return client


def test_get_credit_gate_settings_reads_every_knob(supabase: FakeSupabaseClient) -> None:
    """The consolidated read returns the launch defaults."""
    settings = AppSettingsStore(supabase).get_credit_gate_settings()
    assert settings.welcome_grant_micro_usd == 20_000_000
    assert settings.yc_grant_micro_usd == 526_000_000
    assert settings.pre_verify_allowance_micro_usd == 1_000_000
    assert settings.spend_unlock_requirement == "email"


def test_default_pre_verify_allowance_is_one_dollar(supabase: FakeSupabaseClient) -> None:
    """The seeded default is $1 (1_000_000 micro-USD)."""
    store = AppSettingsStore(supabase)
    assert store.get_pre_verify_allowance_micro_usd() == 1_000_000
    assert PRE_VERIFY_ALLOWANCE_ON_MICRO_USD == 1_000_000


def test_pre_verify_toggle_off_then_back_on(supabase: FakeSupabaseClient) -> None:
    """OFF writes 0 (verify-required), and the toggle flips back to $1."""
    store = AppSettingsStore(supabase)

    assert store.set_pre_verify_allowance_micro_usd(PRE_VERIFY_ALLOWANCE_OFF_MICRO_USD) == 0
    assert store.get_pre_verify_allowance_micro_usd() == 0
    assert supabase.tables["app_settings"][0]["pre_verify_allowance_micro_usd"] == 0

    assert store.set_pre_verify_allowance_micro_usd(PRE_VERIFY_ALLOWANCE_ON_MICRO_USD) == 1_000_000
    assert store.get_pre_verify_allowance_micro_usd() == 1_000_000


def test_welcome_and_yc_grant_amounts_are_editable(supabase: FakeSupabaseClient) -> None:
    """Both grant amounts persist and read back through the consolidated view."""
    store = AppSettingsStore(supabase)

    assert store.set_welcome_grant_micro_usd(50_000_000) == 50_000_000
    assert store.set_yc_grant_micro_usd(1_000_000_000) == 1_000_000_000
    settings = store.get_credit_gate_settings()
    assert settings.welcome_grant_micro_usd == 50_000_000
    assert settings.yc_grant_micro_usd == 1_000_000_000


def test_spend_unlock_requirement_flips_email_and_card(supabase: FakeSupabaseClient) -> None:
    """The mode flips to card and back to email."""
    store = AppSettingsStore(supabase)
    assert store.set_spend_unlock_requirement("card") == "card"
    assert store.get_credit_gate_settings().spend_unlock_requirement == "card"
    assert store.set_spend_unlock_requirement("email") == "email"


def test_write_targets_only_the_singleton_row(supabase: FakeSupabaseClient) -> None:
    """The update filters on the singleton PK, leaving signups_enabled intact."""
    AppSettingsStore(supabase).set_pre_verify_allowance_micro_usd(0)
    row = supabase.tables["app_settings"][0]
    assert row["signups_enabled"] is True


def test_negative_amount_is_rejected_at_the_boundary(supabase: FakeSupabaseClient) -> None:
    """A negative amount fails loudly before hitting the DB check constraint."""
    store = AppSettingsStore(supabase)
    with pytest.raises(ValueError, match="nonnegative int"):
        store.set_pre_verify_allowance_micro_usd(-1)
    with pytest.raises(ValueError, match="nonnegative int"):
        store.set_welcome_grant_micro_usd(-1)


def test_boolean_is_not_a_valid_amount(supabase: FakeSupabaseClient) -> None:
    """``True`` is an int subclass in Python; the store refuses it as a value."""
    with pytest.raises(ValueError, match="nonnegative int"):
        AppSettingsStore(supabase).set_pre_verify_allowance_micro_usd(True)  # type: ignore[arg-type]


def test_unknown_spend_unlock_mode_is_rejected(supabase: FakeSupabaseClient) -> None:
    """An out-of-contract mode is refused, never silently written."""
    with pytest.raises(ValueError, match=r"email.*card"):
        AppSettingsStore(supabase).set_spend_unlock_requirement("sms")
