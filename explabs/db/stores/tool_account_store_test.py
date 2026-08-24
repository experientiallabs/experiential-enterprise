# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the tool-account store (Vault-backed credential, no key on rows)."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.tool_account_store import (
    BalanceSource,
    FetchStatus,
    ToolAccountStore,
    TrackedToolVendor,
)

ORG = "org-tool-1"


def test_ensure_creates_a_balance_only_row_without_a_credential() -> None:
    """A row can exist purely to track a declared balance (no Vault secret)."""
    store = ToolAccountStore(FakeSupabaseClient())
    record = store.ensure(org_id=ORG, vendor=TrackedToolVendor.E2B)
    assert record.vendor is TrackedToolVendor.E2B
    assert record.credential_last4 is None
    assert record.declared_balance_usd is None
    assert record.low_balance_threshold_usd == 5.0


def test_set_declared_balance_marks_self_reported_and_can_untrack() -> None:
    """Declaring sets the figure + self_reported source; null turns it off."""
    store = ToolAccountStore(FakeSupabaseClient())
    declared = store.set_declared_balance(
        org_id=ORG, vendor=TrackedToolVendor.GREPTILE, balance_usd=42.5
    )
    assert declared.declared_balance_usd == 42.5
    assert declared.balance_source is BalanceSource.SELF_REPORTED
    assert declared.declared_balance_set_at is not None

    cleared = store.set_declared_balance(
        org_id=ORG, vendor=TrackedToolVendor.GREPTILE, balance_usd=None
    )
    assert cleared.declared_balance_usd is None
    assert cleared.balance_source is None


def test_set_and_release_credential_round_trips_only_last4_on_the_row() -> None:
    """The credential rides Vault; the row never carries key material."""
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    last4 = store.set_credential(
        org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="cursor-admin-key-abcd"
    )
    assert last4 == "abcd"
    record = store.find(ORG, TrackedToolVendor.CURSOR)
    assert record is not None
    assert record.credential_last4 == "abcd"
    assert "cursor-admin-key" not in record.model_dump_json()
    assert store.release_credential(record.id) == "cursor-admin-key-abcd"


def test_set_credential_is_idempotent_and_rotates_in_place() -> None:
    """A second credential write for the same account rotates the one row.

    The row and its Vault entry are keyed by (org, vendor), so repeated writes
    never fork a second row or leave a second secret behind (the RPC serializes
    concurrent first writes with an on-conflict insert + row lock).
    """
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    store.ensure(org_id=ORG, vendor=TrackedToolVendor.CURSOR)
    store.set_credential(org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="key-first-1234")
    store.set_credential(org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="key-second-5678")
    rows = [row for row in client.tables["tool_accounts"] if row["vendor"] == "cursor"]
    assert len(rows) == 1
    record = store.find(ORG, TrackedToolVendor.CURSOR)
    assert record is not None
    assert record.credential_last4 == "5678"
    assert store.release_credential(record.id) == "key-second-5678"


def test_set_credential_after_a_delete_recreates_the_row_cleanly() -> None:
    """A credential write that lands after the account was deleted re-creates it.

    Models the delete/set race: the RPC's upsert-returning always resolves to a
    locked, existing row, so a credential write can never orphan a Vault secret
    against a row that a concurrent delete removed. Here the delete happens
    first; the subsequent write must create a fresh, releasable account.
    """
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    store.set_credential(org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="key-old-abcd1234")
    assert store.delete(ORG, TrackedToolVendor.CURSOR) is True
    store.set_credential(org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="key-new-wxyz5678")
    record = store.find(ORG, TrackedToolVendor.CURSOR)
    assert record is not None
    assert record.credential_last4 == "5678"
    assert store.release_credential(record.id) == "key-new-wxyz5678"
    rows = [row for row in client.tables["tool_accounts"] if row["vendor"] == "cursor"]
    assert len(rows) == 1


def test_release_after_delete_hands_out_nothing() -> None:
    """A release for an account that was deleted fails; no secret is returned."""
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    store.set_credential(org_id=ORG, vendor=TrackedToolVendor.CURSOR, credential="key-secret-abcd")
    record = store.find(ORG, TrackedToolVendor.CURSOR)
    assert record is not None
    assert store.delete(ORG, TrackedToolVendor.CURSOR) is True
    with pytest.raises((ValueError, RuntimeError)):
        store.release_credential(record.id)


def test_record_fetch_reported_overwrites_the_tracked_balance() -> None:
    """A REPORTED fetch overwrites the balance and stamps the source."""
    store = ToolAccountStore(FakeSupabaseClient())
    store.set_declared_balance(org_id=ORG, vendor=TrackedToolVendor.CURSOR, balance_usd=10.0)
    updated = store.record_fetch(
        org_id=ORG,
        vendor=TrackedToolVendor.CURSOR,
        status=FetchStatus.REPORTED,
        message="Cursor: $88.00 left",
        balance_usd=88.0,
        source=BalanceSource.VENDOR_API,
    )
    assert updated.declared_balance_usd == 88.0
    assert updated.balance_source is BalanceSource.VENDOR_API
    assert updated.last_fetch_status is FetchStatus.REPORTED


def test_record_fetch_pending_keeps_the_balance_but_records_the_attempt() -> None:
    """A PENDING (computer-use stub) fetch never changes the declared balance."""
    store = ToolAccountStore(FakeSupabaseClient())
    store.set_declared_balance(org_id=ORG, vendor=TrackedToolVendor.E2B, balance_usd=25.0)
    updated = store.record_fetch(
        org_id=ORG,
        vendor=TrackedToolVendor.E2B,
        status=FetchStatus.PENDING,
        message="agent not yet enabled",
    )
    assert updated.declared_balance_usd == 25.0
    assert updated.balance_source is BalanceSource.SELF_REPORTED
    assert updated.last_fetch_status is FetchStatus.PENDING
    assert updated.last_fetch_message == "agent not yet enabled"


def test_delete_drops_the_row_and_list_all_spans_orgs() -> None:
    """Delete removes the row; list_all sees every org's accounts."""
    client = FakeSupabaseClient()
    store = ToolAccountStore(client)
    store.ensure(org_id=ORG, vendor=TrackedToolVendor.E2B)
    store.ensure(org_id="org-tool-2", vendor=TrackedToolVendor.DEVIN)
    assert len(store.list_all()) == 2
    assert store.delete(ORG, TrackedToolVendor.E2B) is True
    assert store.find(ORG, TrackedToolVendor.E2B) is None
    assert len(store.list_all()) == 1
