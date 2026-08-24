# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the credit-ledger store's vocabulary guards and views."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.credit_ledger_store import CreditLedgerStore


def _store() -> tuple[CreditLedgerStore, FakeSupabaseClient]:
    client = FakeSupabaseClient()
    client.tables["credit_ledger"] = []
    return CreditLedgerStore(client), client


def test_insert_appends_and_returns_the_typed_entry() -> None:
    """An insert lands with its timestamp and comes back validated."""
    store, client = _store()

    entry = store.insert(
        org_id="org-1",
        entry_type="grant",
        amount_usd=100.0,
        source="admin",
        reason="support bump",
        created_by="user-1",
    )

    assert entry.amount_usd == 100.0
    assert entry.entry_type == "grant"
    assert entry.created_at
    assert len(client.tables["credit_ledger"]) == 1


def test_vocabulary_violations_fail_before_the_database() -> None:
    """Unknown types/sources, zero, and negative non-adjustments are refused."""
    store, _client = _store()

    with pytest.raises(ValueError, match="entry_type"):
        store.insert(org_id="org-1", entry_type="refund", amount_usd=5, source="admin")
    with pytest.raises(ValueError, match="source"):
        store.insert(org_id="org-1", entry_type="grant", amount_usd=5, source="paypal")
    with pytest.raises(ValueError, match="non-zero"):
        store.insert(org_id="org-1", entry_type="grant", amount_usd=0, source="admin")
    with pytest.raises(ValueError, match="adjustments"):
        store.insert(org_id="org-1", entry_type="grant", amount_usd=-5, source="admin")


def test_negative_adjustments_are_allowed() -> None:
    """Adjustments are the one signed entry type (support corrections)."""
    store, _client = _store()

    entry = store.insert(
        org_id="org-1",
        entry_type="adjustment",
        amount_usd=-6.0,
        source="admin",
    )

    assert entry.amount_usd == -6.0


def test_api_view_keeps_server_handles_server_side() -> None:
    """Members see what happened and why, never idempotency refs or actor ids."""
    store, _client = _store()

    entry = store.insert(
        org_id="org-1",
        entry_type="topup",
        amount_usd=25.0,
        source="stripe",
        source_ref="cs_test_123",
        created_by="user-1",
    )

    view = entry.api_view()
    assert view["amount_usd"] == 25.0
    assert "source_ref" not in view
    assert "created_by" not in view


def test_list_for_org_returns_newest_first_and_clamps_the_limit() -> None:
    """History reads are org-scoped, ordered, and bounded."""
    store, client = _store()
    for index in range(3):
        client.tables["credit_ledger"].append(
            {
                "id": f"entry-{index}",
                "org_id": "org-1",
                "entry_type": "grant",
                "amount_usd": 1.0 + index,
                "reason": None,
                "source": "admin",
                "source_ref": None,
                "created_by": None,
                "created_at": f"2026-07-0{index + 1}T00:00:00Z",
            }
        )
    client.tables["credit_ledger"].append(
        {
            "id": "entry-foreign",
            "org_id": "org-2",
            "entry_type": "grant",
            "amount_usd": 9.0,
            "reason": None,
            "source": "admin",
            "source_ref": None,
            "created_by": None,
            "created_at": "2026-07-09T00:00:00Z",
        }
    )

    entries = store.list_for_org("org-1", limit=2)

    assert [entry.id for entry in entries] == ["entry-2", "entry-1"]
