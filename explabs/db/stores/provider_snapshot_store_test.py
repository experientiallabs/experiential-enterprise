# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Snapshot store: inserts land typed, latest-read skips self-reported rows."""

from __future__ import annotations

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.provider_connection_store import ConnectableProvider
from explabs.db.stores.provider_snapshot_store import ProviderSnapshotStore, SnapshotSource


def test_insert_returns_the_typed_snapshot() -> None:
    """The stored row carries the reading, its source, and a timestamp."""
    store = ProviderSnapshotStore(FakeSupabaseClient())
    snapshot = store.insert(
        org_id="org-1",
        connection_id="conn-1",
        provider=ConnectableProvider.OPENROUTER,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=41.2,
        credits_remaining_usd=82.91,
        usage_limit_usd=100.0,
        detail={"limit_reset": "daily"},
    )
    assert snapshot.provider is ConnectableProvider.OPENROUTER
    assert snapshot.source is SnapshotSource.PROVIDER_API
    assert snapshot.credits_remaining_usd == 82.91
    assert snapshot.taken_at


def test_latest_provider_read_skips_self_reported_rows() -> None:
    """A manual declare must never suppress a real provider query.

    The staleness floor gates provider reads only.
    """
    client = FakeSupabaseClient()
    store = ProviderSnapshotStore(client)
    real = store.insert(
        org_id="org-1",
        connection_id="conn-1",
        provider=ConnectableProvider.OPENROUTER,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=41.2,
    )
    store.insert(
        org_id="org-1",
        connection_id="conn-1",
        provider=ConnectableProvider.OPENROUTER,
        source=SnapshotSource.SELF_REPORTED,
        credits_remaining_usd=50.0,
    )
    latest = store.latest_provider_read("conn-1")
    assert latest is not None
    assert latest.id == real.id
    assert store.latest_provider_read("conn-other") is None
