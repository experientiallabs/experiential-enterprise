# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the shared world-model catalog store."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.catalog_store import CatalogEntryStore


def _create_entry(store: CatalogEntryStore, *, name: str = "tau-bench") -> str:
    """Create one minimal entry and return its id."""
    record = store.create(
        name=name,
        serve_provider="anthropic",
        serve_model="claude-sonnet-4-5",
        storage_path=f"catalog/{name}/bundle.tar.gz",
        byte_size=128,
        sha256="digest",
        storage_bucket="explabs-artifacts",
        display_name="Tau Bench",
        description="A benchmark world model.",
        metrics={"accuracy": 0.8},
        source_world_model_id="wm-source",
    )
    return record.id


def test_create_and_get_round_trip() -> None:
    """Created entries read back with every snapshot and integrity field."""
    client = FakeSupabaseClient()
    store = CatalogEntryStore(client)
    entry_id = _create_entry(store)
    record = store.get(entry_id)
    assert record.name == "tau-bench"
    assert record.serve_provider == "anthropic"
    assert record.storage_path == "catalog/tau-bench/bundle.tar.gz"
    assert record.byte_size == 128
    assert record.sha256 == "digest"
    assert record.metrics == {"accuracy": 0.8}
    assert record.source_world_model_id == "wm-source"
    assert record.deprecated_at is None


def test_create_rejects_non_slug_name() -> None:
    """Entry names must satisfy the wmo slug rule."""
    store = CatalogEntryStore(FakeSupabaseClient())
    with pytest.raises(ValueError, match="must match"):
        store.create(
            name="Bad Name",
            serve_provider="anthropic",
            serve_model="claude-sonnet-4-5",
            storage_path="catalog/bad/bundle.tar.gz",
            byte_size=1,
            sha256="digest",
            storage_bucket="explabs-artifacts",
        )


def test_create_rejects_empty_integrity_fields() -> None:
    """Bundle pointer fields are required and validated loudly."""
    store = CatalogEntryStore(FakeSupabaseClient())
    with pytest.raises(ValueError, match="storage_path"):
        store.create(
            name="entry",
            serve_provider="anthropic",
            serve_model="claude-sonnet-4-5",
            storage_path="",
            byte_size=1,
            sha256="digest",
            storage_bucket="explabs-artifacts",
        )
    with pytest.raises(ValueError, match="sha256"):
        store.create(
            name="entry",
            serve_provider="anthropic",
            serve_model="claude-sonnet-4-5",
            storage_path="catalog/entry/bundle.tar.gz",
            byte_size=1,
            sha256="",
            storage_bucket="explabs-artifacts",
        )
    with pytest.raises(ValueError, match="byte_size"):
        store.create(
            name="entry",
            serve_provider="anthropic",
            serve_model="claude-sonnet-4-5",
            storage_path="catalog/entry/bundle.tar.gz",
            byte_size=-1,
            sha256="digest",
            storage_bucket="explabs-artifacts",
        )


def test_list_live_excludes_deprecated_and_orders_newest_first() -> None:
    """Listing returns only live entries, newest first."""
    client = FakeSupabaseClient()
    store = CatalogEntryStore(client)
    first_id = _create_entry(store, name="first-entry")
    second_id = _create_entry(store, name="second-entry")
    # Force distinct, ordered timestamps: the fake orders by column value and
    # both entries were created within the same wall-clock instant.
    for row in client.tables["wm_catalog_entries"]:
        row["created_at"] = (
            "2026-07-01T00:00:00Z" if row["id"] == first_id else "2026-07-02T00:00:00Z"
        )
    store.deprecate(first_id)
    live = store.list_live()
    assert [record.id for record in live] == [second_id]


def test_find_live_by_name_skips_deprecated() -> None:
    """Deprecated entries release their name for re-publishing."""
    store = CatalogEntryStore(FakeSupabaseClient())
    entry_id = _create_entry(store)
    assert store.find_live_by_name("tau-bench") is not None
    store.deprecate(entry_id)
    assert store.find_live_by_name("tau-bench") is None


def test_deprecate_is_idempotent() -> None:
    """Re-deprecating keeps the original deprecation timestamp."""
    store = CatalogEntryStore(FakeSupabaseClient())
    entry_id = _create_entry(store)
    first = store.deprecate(entry_id)
    assert first.deprecated_at is not None
    second = store.deprecate(entry_id)
    assert second.deprecated_at == first.deprecated_at


def test_like_and_unlike_round_trip() -> None:
    """Likes tally per entry and per user, idempotently in both directions."""
    client = FakeSupabaseClient()
    store = CatalogEntryStore(client)
    entry_id = _create_entry(store)
    store.like(entry_id, "user-1")
    store.like(entry_id, "user-1")
    store.like(entry_id, "user-2")
    assert store.like_counts([entry_id]) == {entry_id: 2}
    assert store.liked_entry_ids("user-1", [entry_id]) == {entry_id}
    store.unlike(entry_id, "user-1")
    store.unlike(entry_id, "user-1")
    assert store.like_counts([entry_id]) == {entry_id: 1}
    assert store.liked_entry_ids("user-1", [entry_id]) == set()


def test_like_counts_default_to_zero() -> None:
    """Entries with no likes tally 0, and empty input costs no query."""
    store = CatalogEntryStore(FakeSupabaseClient())
    entry_id = _create_entry(store)
    assert store.like_counts([entry_id]) == {entry_id: 0}
    assert store.like_counts([]) == {}
    assert store.liked_entry_ids("user-1", []) == set()
