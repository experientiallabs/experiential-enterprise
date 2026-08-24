# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the superadmin-key auth store."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.api_key_store import hash_api_key
from explabs.db.stores.platform_admin_key_store import (
    SUPERADMIN_KEY_PREFIX,
    PlatformAdminKeyStore,
)

_SECRET = f"{SUPERADMIN_KEY_PREFIX}store_test_secret"


def _client() -> FakeSupabaseClient:
    client = FakeSupabaseClient()
    client.tables["platform_admin_keys"] = [
        {
            "id": "sakey-live",
            "user_id": "operator-1",
            "owner_email": "operator-1@explabs.example",
            "name": "live",
            "key_prefix": _SECRET[:13],
            "key_hash": hash_api_key(_SECRET),
            "created_at": "2026-06-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": None,
        },
        {
            "id": "sakey-dead",
            "user_id": "operator-1",
            "owner_email": "operator-1@explabs.example",
            "name": "revoked twin (same owner, different secret)",
            "key_prefix": "xpladmin_dead",
            "key_hash": hash_api_key(f"{SUPERADMIN_KEY_PREFIX}dead"),
            "created_at": "2026-06-01T00:00:00Z",
            "last_used_at": None,
            "revoked_at": "2026-06-02T00:00:00Z",
        },
    ]
    return client


def test_find_active_by_secret_resolves_the_live_row() -> None:
    """A live secret resolves to its owner; the hash never leaves the store."""
    record = PlatformAdminKeyStore(_client()).find_active_by_secret(_SECRET)
    assert record is not None
    assert record.id == "sakey-live"
    assert record.user_id == "operator-1"


def test_find_active_by_secret_rejects_revoked_and_unknown() -> None:
    """Revoked rows and unknown secrets both resolve to nothing."""
    store = PlatformAdminKeyStore(_client())
    assert store.find_active_by_secret(f"{SUPERADMIN_KEY_PREFIX}dead") is None
    assert store.find_active_by_secret(f"{SUPERADMIN_KEY_PREFIX}nope") is None


def test_touch_last_used_stamps_the_row() -> None:
    """The display touch writes last_used_at on the addressed row only."""
    client = _client()
    PlatformAdminKeyStore(client).touch_last_used("sakey-live")
    rows = {row["id"]: row for row in client.tables["platform_admin_keys"]}
    assert rows["sakey-live"]["last_used_at"] is not None
    assert rows["sakey-dead"]["last_used_at"] is None
