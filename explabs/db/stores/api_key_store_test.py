# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Expiry semantics of ``ApiKeyStore`` lookups.

The end-to-end authentication paths (revocation, org scoping, last-used
bumps) are covered in ``explabs/api/api_keys_test.py``; this module pins the
store-level expiry boundary.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.api_key_store import ApiKeyStore, _is_expired, hash_api_key


def _key_row(secret: str, *, expires_at: str | None) -> dict[str, object]:
    """A minimal live ``api_keys`` row for the fake client."""
    return {
        "id": "key-1",
        "org_id": "org-1",
        "name": "test key",
        "key_prefix": secret[:12],
        "key_suffix": secret[-4:],
        "key_hash": hash_api_key(secret),
        "created_at": "2026-06-07T00:00:00Z",
        "last_used_at": None,
        "revoked_at": None,
        "expires_at": expires_at,
    }


def test_find_active_returns_key_with_no_expiry() -> None:
    """NULL expiry means the key never expires."""
    client = FakeSupabaseClient()
    client.tables["api_keys"] = [_key_row("xpl_secret", expires_at=None)]

    record = ApiKeyStore(client).find_active_by_secret("xpl_secret")

    assert record is not None
    assert record.expires_at is None


def test_find_active_rejects_expired_key() -> None:
    """An expiry in the past hides the key from resolution."""
    past = (datetime.now(tz=UTC) - timedelta(minutes=1)).isoformat()
    client = FakeSupabaseClient()
    client.tables["api_keys"] = [_key_row("xpl_secret", expires_at=past)]

    assert ApiKeyStore(client).find_active_by_secret("xpl_secret") is None


def test_find_active_returns_key_expiring_in_the_future() -> None:
    """An expiry that has not passed leaves the key live."""
    future = (datetime.now(tz=UTC) + timedelta(days=30)).isoformat()
    client = FakeSupabaseClient()
    client.tables["api_keys"] = [_key_row("xpl_secret", expires_at=future)]

    record = ApiKeyStore(client).find_active_by_secret("xpl_secret")

    assert record is not None
    assert record.expires_at == future


def test_is_expired_parses_utc_suffix_forms() -> None:
    """Both `Z` and `+00:00` UTC spellings compare correctly."""
    assert _is_expired("2026-01-01T00:00:00Z")
    assert _is_expired("2026-01-01T00:00:00+00:00")
    assert not _is_expired("2126-01-01T00:00:00Z")
    assert not _is_expired(None)


def _org_key_row(
    key_id: str, *, org_id: str, created_at: str, revoked_at: str | None
) -> dict[str, object]:
    """An ``api_keys`` row for the list-scoping tests."""
    return {
        "id": key_id,
        "org_id": org_id,
        "name": key_id,
        "key_prefix": f"xpl_{key_id}",
        # Legacy row: minted before key_suffix existed, so no stored tail.
        "key_suffix": None,
        "key_hash": hash_api_key(key_id),
        "created_at": created_at,
        "last_used_at": None,
        "revoked_at": revoked_at,
        "expires_at": None,
    }


def _list_client() -> FakeSupabaseClient:
    """Two orgs' keys, org-1 carrying one revoked row, for list scoping."""
    client = FakeSupabaseClient()
    client.tables["api_keys"] = [
        _org_key_row("k-old", org_id="org-1", created_at="2026-06-01T00:00:00Z", revoked_at=None),
        _org_key_row("k-new", org_id="org-1", created_at="2026-06-03T00:00:00Z", revoked_at=None),
        _org_key_row(
            "k-gone",
            org_id="org-1",
            created_at="2026-06-02T00:00:00Z",
            revoked_at="2026-06-04T00:00:00Z",
        ),
        _org_key_row("k-other", org_id="org-2", created_at="2026-06-01T00:00:00Z", revoked_at=None),
    ]
    return client


def test_list_for_org_excludes_revoked_and_scopes_by_org() -> None:
    """The default list is the org's live keys, newest first, no other org."""
    records = ApiKeyStore(_list_client()).list_for_org("org-1")

    assert [r.id for r in records] == ["k-new", "k-old"]
    assert all(r.org_id == "org-1" for r in records)


def test_list_for_org_include_revoked_returns_all_org_keys() -> None:
    """The opt-in flag surfaces revoked keys, still scoped to the org."""
    records = ApiKeyStore(_list_client()).list_for_org("org-1", include_revoked=True)

    assert {r.id for r in records} == {"k-old", "k-new", "k-gone"}


def test_find_creator_returns_the_minting_user() -> None:
    """The narrow creator lookup reads created_by by key id."""
    client = FakeSupabaseClient()
    row = _key_row("xpl_secret", expires_at=None)
    row["created_by"] = "user-founder"
    client.tables["api_keys"] = [row]

    assert ApiKeyStore(client).find_creator("key-1") == "user-founder"


def test_find_creator_is_none_for_creatorless_or_unknown_keys() -> None:
    """Seeded/migration-era keys (created_by NULL) and missing ids read None."""
    client = FakeSupabaseClient()
    row = _key_row("xpl_secret", expires_at=None)
    row["created_by"] = None
    client.tables["api_keys"] = [row]

    store = ApiKeyStore(client)
    assert store.find_creator("key-1") is None
    assert store.find_creator("key-unknown") is None
